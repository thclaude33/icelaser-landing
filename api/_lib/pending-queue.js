// api/_lib/pending-queue.js
// Fila de mensagens pendentes (28/05/2026 — incidente Rosane conv 614).
//
// PROBLEMA: cliente manda 2+ mensagens em sequência. A 2ª chega enquanto a Bia
// ainda processa a 1ª, bate no lock `rl:thread:{conv}:in_flight` e tomava HTTP 429
// → era DESCARTADA. A Bia nunca via a pergunta (ex: "onde fica a unidade?").
//
// SOLUÇÃO: em vez de descartar no 429, enfileira em `bia:pending:{conv}`. Quando
// o lock libera, o cron `bia-pending-drain` re-injeta o lote como UM turno novo na
// MESMA sessão (reuse), entrega a resposta (2º balão) e SÓ ENTÃO remove da fila.
//
// Garantias (at-least-once — corrige review Codex 28/05):
//   - peekPending (LRANGE) NÃO remove; ackPending (LTRIM N) só após entrega OK.
//     Se o POST/poll falhar, a mensagem CONTINUA na fila pro próximo tick.
//   - Dedup por chatwoot_message_id (Chatwoot faz retry de webhook).
//   - reindexIfRemaining: se chegou msg DURANTE o drain, re-ZADD no índice
//     (não ZREM cego) — não orfana.
//   - inject-marker: turno já injetado não é re-injetado (evita turno duplicado
//     quando o poll falha e o tick seguinte só precisa entregar a resposta).
//   - Índice sorted-set pro cron achar convs sem SCAN; guard anti-loop.

import {
  kvClaim,
  kvRelease,
  kvGet,
  kvSet,
  kvDel,
  kvRpush,
  kvLlen,
  kvLrange,
  kvLtrim,
  kvExpire,
  kvZadd,
  kvZrem,
  kvZrangebyscore,
  kvIncrWithExpire,
} from './kv-rate-limit.js';

const PENDING_PREFIX = 'bia:pending:';
export const PENDING_INDEX = 'bia:pending:index';
const SEEN_PREFIX = 'bia:pending:seen:';
const CYCLE_PREFIX = 'bia:pending:cycles:';
const INJECTED_PREFIX = 'bia:pending:injected:';

const SEEN_TTL_SEC = 600; // 10min — janela de dedup pra retry do Chatwoot
const PENDING_TTL_SEC = 3600; // 1h — hygiene anti-órfã na lista
const CYCLE_WINDOW_SEC = 300; // 5min — janela do guard anti-loop
const INJECTED_TTL_SEC = 600; // 10min — marker de turno injetado aguardando entrega
const MAX_CYCLES = 3; // máx drenagens por conv em 5min

const pendingKey = (conv) => `${PENDING_PREFIX}${conv}`;
const seenKey = (conv, msgId) => `${SEEN_PREFIX}${conv}:${msgId}`;
const cycleKey = (conv) => `${CYCLE_PREFIX}${conv}`;
const injectedKey = (conv) => `${INJECTED_PREFIX}${conv}`;

/**
 * Enfileira uma mensagem do cliente que chegou durante o lock in_flight.
 * Dedup por chatwoot_message_id (retry do Chatwoot não duplica).
 *
 * @param {string|number} conv chatwoot_thread_id
 * @param {string} telefone telefone do cliente (E.164 sem +)
 * @param {string} text texto JÁ TRANSCRITO (áudio vira texto antes do claim)
 * @param {string|number|null} msgId chatwoot_message_id (null no direct path)
 * @returns {Promise<{ ok: boolean, dedup: boolean, length?: number }>}
 */
export async function enqueuePending(conv, telefone, text, msgId) {
  if (!conv || !text) return { ok: false, dedup: false };

  let seenClaimKey = null;
  let seenClaimed = false;
  if (msgId !== null && msgId !== undefined && String(msgId) !== '') {
    seenClaimKey = seenKey(conv, msgId);
    const seen = await kvClaim(seenClaimKey, '1', SEEN_TTL_SEC);
    if (!seen.ok && !seen.fallback) {
      return { ok: true, dedup: true };
    }
    seenClaimed = seen.ok === true && seen.fallback !== true;
  }

  const item = JSON.stringify({
    telefone: telefone || null,
    text: String(text),
    msg_id: msgId != null ? String(msgId) : null,
    ts: Date.now(),
  });

  const pushed = await kvRpush(pendingKey(conv), item);
  if (!pushed.ok || pushed.fallback || !pushed.length) {
    if (seenClaimed && seenClaimKey) await kvRelease(seenClaimKey);
    return { ok: false, dedup: false, error: pushed.error || 'rpush_failed' };
  }
  await kvExpire(pendingKey(conv), PENDING_TTL_SEC);
  const indexed = await kvZadd(PENDING_INDEX, Math.floor(Date.now() / 1000), String(conv));
  if (!indexed.ok || indexed.fallback) {
    if (seenClaimed && seenClaimKey) await kvRelease(seenClaimKey);
    return { ok: false, dedup: false, length: pushed.length, error: indexed.error || 'index_failed' };
  }

  return { ok: true, dedup: false, length: pushed.length };
}

/**
 * PEEK — lê as pendentes SEM remover (LRANGE). A remoção só acontece em
 * ackPending(), após a entrega confirmada. Isso garante at-least-once:
 * se o POST/poll falhar, as mensagens continuam na fila.
 *
 * @param {string|number} conv
 * @returns {Promise<{ items: Array<{telefone:string|null,text:string,msg_id:string|null,ts:number}>, count: number }>}
 */
export async function peekPending(conv) {
  const key = pendingKey(conv);
  const lenR = await kvLlen(key);
  const n = lenR.length || 0;
  if (n === 0) return { items: [], count: 0 };
  const rangeR = await kvLrange(key, 0, n - 1);
  const raw = rangeR.items || [];
  const items = raw.map((s) => {
    try { return JSON.parse(s); }
    catch { return { telefone: null, text: String(s), msg_id: null, ts: 0 }; }
  });
  return { items, count: items.length };
}

/**
 * ACK — remove EXATAMENTE os N primeiros itens (os que foram entregues),
 * via LTRIM N -1. Itens que chegaram DURANTE o drain (índices >= N) sobrevivem
 * (não usa DEL). Chamar SÓ após a entrega ter sido confirmada no Chatwoot.
 *
 * @param {string|number} conv
 * @param {number} n quantidade de itens entregues (= count do peek)
 */
export async function ackPending(conv, n) {
  if (!n || n <= 0) return { ok: true, trimmed: 0 };
  await kvLtrim(pendingKey(conv), n, -1);
  return { ok: true, trimmed: n };
}

/**
 * Após o ack, re-sincroniza o índice: se ainda sobrou item na lista (msg que
 * chegou durante o drain), re-ZADD pra o cron pegar no próximo tick. Se vazia,
 * ZREM (sai do índice). Corrige o P1-órfão (ZREM cego apontado pelo Codex).
 */
export async function reindexIfRemaining(conv) {
  const lenR = await kvLlen(pendingKey(conv));
  const remaining = lenR.length || 0;
  if (remaining > 0) {
    await kvZadd(PENDING_INDEX, Math.floor(Date.now() / 1000), String(conv));
    return { remaining, reindexed: true };
  }
  await kvZrem(PENDING_INDEX, String(conv));
  return { remaining: 0, reindexed: false };
}

/** Marca que um turno (de N itens) foi injetado na sessão e aguarda entrega. */
export async function setInjected(conv, data) {
  await kvSet(injectedKey(conv), JSON.stringify(data), INJECTED_TTL_SEC);
  return { ok: true };
}

/** Lê o marker de turno injetado (ou null). */
export async function getInjected(conv) {
  const r = await kvGet(conv ? injectedKey(conv) : '');
  if (!r.ok || !r.value) return null;
  try { return JSON.parse(r.value); } catch { return null; }
}

/** Remove o marker de turno injetado (após entrega ou descarte). */
export async function clearInjected(conv) {
  await kvDel(injectedKey(conv));
  return { ok: true };
}

/** Remove só do índice (lista permanece — usado quando não há sessão reusável). */
export async function clearPendingIndex(conv) {
  await kvZrem(PENDING_INDEX, String(conv));
  return { ok: true };
}

/** Limpa TUDO de uma conv (lista + índice + marker). Usado quando humano assumiu. */
export async function clearPendingAll(conv) {
  await kvDel(pendingKey(conv));
  await kvZrem(PENDING_INDEX, String(conv));
  await kvDel(injectedKey(conv));
  return { ok: true };
}

/**
 * Lista convs com pendência (do índice sorted-set). Score = epoch de enfileiramento.
 * @returns {Promise<string[]>} array de chatwoot_thread_id (strings)
 */
export async function listPendingConvs(limit = 20, minAgeSec = 0) {
  const maxScore = Math.floor(Date.now() / 1000) - minAgeSec;
  const r = await kvZrangebyscore(PENDING_INDEX, 0, maxScore, limit);
  return r.members || [];
}

/**
 * Guard anti-loop: incrementa contador de ciclos de drenagem (janela 5min).
 * @returns {Promise<{ count: number, exceeded: boolean }>}
 */
export async function bumpDrainCycle(conv) {
  const r = await kvIncrWithExpire(cycleKey(conv), CYCLE_WINDOW_SEC);
  return { count: r.count || 0, exceeded: (r.count || 0) > MAX_CYCLES };
}

export const _internals = {
  pendingKey, seenKey, cycleKey, injectedKey,
  SEEN_TTL_SEC, PENDING_TTL_SEC, INJECTED_TTL_SEC, MAX_CYCLES,
};
