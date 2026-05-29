// api/cron/bia-pending-drain.js
// Cron 1×/min — drena mensagens pendentes (28/05/2026, incidente Rosane conv 614).
//
// Quando o cliente manda 2+ mensagens em rajada, a 2ª chega enquanto a Bia ainda
// processa a 1ª, toma lock in_flight e — em vez de ser descartada (429) — é
// enfileirada em bia:pending:{conv} (ver api/_lib/pending-queue.js).
//
// Este cron, quando o lock libera, drena TODAS as pendentes de uma vez (lote),
// re-injeta como UM turno novo na MESMA sessão Anthropic (reuse), e o cron
// bia-postback entrega a resposta (2º balão). Sem loopback HTTP, sem waitUntil.
//
// Guardas: lock-free check (não atropela turno em andamento) + revalidação de
// bia_teste (se humano assumiu, descarta sem responder) + anti-loop (máx 3
// ciclos/5min por conv) + skipIfNotPrimary (roda só no projeto primário).

import { skipIfNotPrimary } from '../_lib/primary-project.js';
import { resolveSessionForThread, setActiveSession } from '../_lib/session-reuse.js';
import { kvGet } from '../_lib/kv-rate-limit.js';
import {
  listPendingConvs,
  drainPending,
  clearPendingAll,
  clearPendingIndex,
  bumpDrainCycle,
} from '../_lib/pending-queue.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://chatwoot-production-af5f.up.railway.app';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const SHADOW_LABEL = process.env.BIA_SHADOW_LABEL || 'bia_teste';
const MAX_PER_RUN = 15;

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  return auth === `Bearer ${expected}`;
}

function anthropicHeaders() {
  return {
    'x-api-key': process.env.ANTHROPIC_API_KEY_ICELASER,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'managed-agents-2026-04-01',
    'Content-Type': 'application/json',
  };
}

// Revalida que a conv ainda tem o label bia_teste. Se o humano removeu (assumiu
// o atendimento), as pendentes são descartadas — a Bia não responde por cima.
async function stillBiaTeste(conv) {
  try {
    const resp = await fetch(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conv}`,
      { headers: { 'api_access_token': process.env.CHATWOOT_API_TOKEN }, signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) return { ok: false, unknown: true };
    const body = await resp.json();
    const con0 = body?.payload || body?.data || body || {};
    const labels = Array.isArray(con0.labels) ? con0.labels.map((l) => String(l).toLowerCase()) : [];
    return { ok: true, has: labels.includes(SHADOW_LABEL.toLowerCase()) };
  } catch (e) {
    return { ok: false, unknown: true, error: String(e?.message || e) };
  }
}

// Re-injeta o lote de mensagens como UM turno novo na sessão reusada.
async function postTurn(sessionId, telefone, text) {
  const content = `(TELEFONE_CLIENTE: +${telefone}) ${text}`;
  const resp = await fetch(`${ANTHROPIC_BASE}/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: anthropicHeaders(),
    body: JSON.stringify({ events: [{ type: 'user.message', content: [{ type: 'text', text: content }] }] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Anthropic event POST HTTP ${resp.status}: ${detail.slice(0, 200)}`);
  }
  return true;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (skipIfNotPrimary(res, 'bia-pending-drain')) return;

  const stats = { scanned: 0, drained: 0, skipped_busy: 0, skipped_no_label: 0, skipped_no_session: 0, loop_guard: 0, errors: 0 };

  let convs = [];
  try {
    convs = await listPendingConvs(MAX_PER_RUN, 0);
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'list_failed', detail: String(e?.message || e) });
  }

  for (const conv of convs) {
    stats.scanned += 1;
    try {
      // 1) Lock ativo? Turno em andamento → espera o próximo tick (não atropela).
      const lock = await kvGet(`rl:thread:${conv}:in_flight`);
      if (lock.ok && lock.value) { stats.skipped_busy += 1; continue; }

      // 2) Anti-loop: máx 3 drenagens/5min por conv.
      const cycle = await bumpDrainCycle(conv);
      if (cycle.exceeded) {
        console.warn(`[BIA-DRAIN] loop guard conv=${conv} cycles=${cycle.count} — limpando pendência`);
        await clearPendingAll(conv);
        stats.loop_guard += 1;
        continue;
      }

      // 3) Revalida bia_teste (humano pode ter assumido entre enfileirar e drenar).
      const label = await stillBiaTeste(conv);
      if (label.ok && !label.has) {
        console.log(`[BIA-DRAIN] bia_teste removido conv=${conv} — descartando pendência (humano assumiu)`);
        await clearPendingAll(conv);
        stats.skipped_no_label += 1;
        continue;
      }
      // label.unknown (Chatwoot indisponível) → não descarta, tenta próximo tick.
      if (label.unknown) { stats.errors += 1; continue; }

      // 4) Sessão reusável? (após balloon1, setActiveSession renovou TTL 30min)
      const reuse = await resolveSessionForThread(conv);
      if (!reuse.reused || !reuse.sessionId) {
        // Sem sessão ativa (raro: TTL expirou). Não dá pra re-injetar barato; deixa
        // a lista expirar (TTL 1h) e tira do índice pra não varrer toda hora.
        await clearPendingIndex(conv);
        stats.skipped_no_session += 1;
        continue;
      }

      // 5) Drena TODAS as pendentes (lote) e concatena na ordem que chegaram.
      const { items } = await drainPending(conv);
      if (!items.length) { await clearPendingIndex(conv); continue; }
      const telefone = items.find((i) => i.telefone)?.telefone || '';
      const text = items.map((i) => i.text).filter(Boolean).join('\n');
      if (!telefone || !text) { await clearPendingIndex(conv); continue; }

      // 6) Re-injeta como turno novo. bia-postback entrega a resposta (2º balão).
      await postTurn(reuse.sessionId, telefone, text);
      try { await setActiveSession(conv, reuse.sessionId); } catch { /* renova TTL — non-fatal */ }
      await clearPendingIndex(conv);
      stats.drained += 1;
      console.log(`[BIA-DRAIN] conv=${conv} sid=${reuse.sessionId} msgs=${items.length} re-injetadas`);
    } catch (e) {
      stats.errors += 1;
      console.error(`[BIA-DRAIN] conv=${conv} erro: ${e?.message || e}`);
    }
  }

  return res.status(200).json({ ok: true, ...stats });
}
