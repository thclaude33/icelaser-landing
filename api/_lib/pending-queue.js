// api/_lib/pending-queue.js
// Fila de mensagens pendentes (28/05/2026 — incidente Rosane conv 614).
//
// PROBLEMA: cliente manda 2+ mensagens em sequência. A 2ª chega enquanto a Bia
// ainda processa a 1ª, bate no lock `rl:thread:{conv}:in_flight` e tomava HTTP 429
// → era DESCARTADA. A Bia nunca via a pergunta (ex: "onde fica a unidade?").
//
// SOLUÇÃO: em vez de descartar no 429, enfileira em `bia:pending:{conv}`. Quando
// o lock libera, o cron `bia-pending-drain` drena TODAS as pendentes de uma vez
// (lote → 1 turno → 1 resposta extra = "2º balão") e a Bia responde a pergunta.
//
// Garantias:
//   - Dedup por chatwoot_message_id (Chatwoot faz retry de webhook)
//   - Drain atômico LRANGE+LTRIM (não DEL — não apaga msg que chegou no meio)
//   - Índice sorted-set pro cron achar convs com pendência sem SCAN
//   - Sem loopback HTTP, sem waitUntil, sem mexer no webhook de entrada

import {
  kvClaim,
  kvRpush,
  kvLlen,
  kvLrange,
  kvLtrim,
  kvExpire,
  kvDel,
  kvZadd,
  kvZrem,
  kvZrangebyscore,
  kvIncrWithExpire,
} from './kv-rate-limit.js';

const PENDING_PREFIX = 'bia:pending:';
export const PENDING_INDEX = 'bia:pending:index';
const SEEN_PREFIX = 'bia:pending:seen:';
const CYCLE_PREFIX = 'bia:pending:cycles:';

const SEEN_TTL_SEC = 600; // 10min — janela de dedup pra retry do Chatwoot
const PENDING_TTL_SEC = 3600; // 1h — hygiene anti-órfã na lista
const CYCLE_WINDOW_SEC = 300; // 5min — janela do guard anti-loop
const MAX_CYCLES = 3; // máx drenagens por conv em 5min

const pendingKey = (conv) => `${PENDING_PREFIX}${conv}`;
const seenKey = (conv, msgId) => `${SEEN_PREFIX}${conv}:${msgId}`;
const cycleKey = (conv) => `${CYCLE_PREFIX}${conv}`;

/**
 * Enfileira uma mensagem do cliente que chegou durante o lock in_flight.
 * Dedup por chatwoot_message_id (retry do Chatwoot não duplica).
 *
 * @param {string|number} conv chatwoot_thread_id
 * @param {string} telefone telefone do cliente (E.164 sem +)
 * @param {string} text texto JÁ TRANSCRITO da mensagem (áudio vira texto antes do claim)
 * @param {string|number|null} msgId chatwoot_message_id (pode ser null no direct path)
 * @returns {Promise<{ ok: boolean, dedup: boolean, length?: number }>}
 */
export async function enqueuePending(conv, telefone, text, msgId) {
  if (!conv || !text) return { ok: false, dedup: false };

  // Dedup: SETNX seen:{conv}:{msgId}. Se já existe → mensagem repetida (retry), pula.
  if (msgId !== null && msgId !== undefined && String(msgId) !== '') {
    const seen = await kvClaim(seenKey(conv, msgId), '1', SEEN_TTL_SEC);
    if (!seen.ok && !seen.fallback) {
      return { ok: true, dedup: true };
    }
  }

  const item = JSON.stringify({
    telefone: telefone || null,
    text: String(text),
    msg_id: msgId != null ? String(msgId) : null,
    ts: Date.now(),
  });

  const pushed = await kvRpush(pendingKey(conv), item);
  await kvExpire(pendingKey(conv), PENDING_TTL_SEC);
  await kvZadd(PENDING_INDEX, Math.floor(Date.now() / 1000), String(conv));

  return { ok: true, dedup: false, length: pushed.length };
}

/**
 * Drena TODAS as pendentes de uma conv, atomicamente.
 * Lê N itens (LRANGE 0 N-1) e remove exatamente esses N (LTRIM N -1),
 * preservando mensagens que chegaram DURANTE o drain.
 *
 * @param {string|number} conv
 * @returns {Promise<{ items: Array<{ telefone: string|null, text: string, msg_id: string|null, ts: number }>, drained: number }>}
 */
export async function drainPending(conv) {
  const key = pendingKey(conv);
  const lenR = await kvLlen(key);
  const n = lenR.length || 0;
  if (n === 0) return { items: [], drained: 0 };

  const rangeR = await kvLrange(key, 0, n - 1);
  const raw = rangeR.items || [];
  // Mantém só o que chegou DURANTE a leitura (índices >= n). NÃO usa DEL.
  await kvLtrim(key, n, -1);

  const items = raw.map((s) => {
    try {
      return JSON.parse(s);
    } catch {
      return { telefone: null, text: String(s), msg_id: null, ts: 0 };
    }
  });
  return { items, drained: items.length };
}

/**
 * Remove a conv do índice (chamado quando não há mais o que processar ou
 * quando a conversa não deve mais ser respondida — ex: bia_teste removido).
 */
export async function clearPendingIndex(conv) {
  await kvZrem(PENDING_INDEX, String(conv));
  return { ok: true };
}

/**
 * Limpa TUDO de uma conv (lista + índice). Usado quando o humano assumiu
 * (bia_teste removido) — descarta as pendentes sem responder.
 */
export async function clearPendingAll(conv) {
  await kvDel(pendingKey(conv));
  await kvZrem(PENDING_INDEX, String(conv));
  return { ok: true };
}

/**
 * Lista convs com pendência (do índice sorted-set). Score = epoch de enfileiramento.
 * minAgeSec: só retorna pendências com pelo menos X segundos (dá tempo do lock
 * liberar antes de tentar reprocessar). Default 0.
 *
 * @returns {Promise<string[]>} array de chatwoot_thread_id (strings)
 */
export async function listPendingConvs(limit = 20, minAgeSec = 0) {
  const maxScore = Math.floor(Date.now() / 1000) - minAgeSec;
  const r = await kvZrangebyscore(PENDING_INDEX, 0, maxScore, limit);
  return r.members || [];
}

/**
 * Guard anti-loop: incrementa contador de ciclos de drenagem da conv (janela 5min).
 * Retorna { count, exceeded }. Se exceeded, o cron deve limpar a pendência e parar.
 */
export async function bumpDrainCycle(conv) {
  const r = await kvIncrWithExpire(cycleKey(conv), CYCLE_WINDOW_SEC);
  return { count: r.count || 0, exceeded: (r.count || 0) > MAX_CYCLES };
}

export const _internals = { pendingKey, seenKey, cycleKey, SEEN_TTL_SEC, PENDING_TTL_SEC, MAX_CYCLES };
