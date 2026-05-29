// api/cron/bia-pending-drain.js
// Cron 1×/min — entrega mensagens pendentes em rajada (incidente Rosane conv 614).
//
// Quando o cliente manda 2+ mensagens, a 2ª chega durante o lock in_flight e é
// enfileirada em bia:pending:{conv} (api/_lib/pending-queue.js) em vez de ser
// descartada no 429. Este cron, quando o lock libera, re-injeta o lote como UM
// turno novo na MESMA sessão (reuse) e ENTREGA a resposta ele mesmo (2º balão).
//
// Correções da review (Codex 28/05):
//   P0 — at-least-once: peek (LRANGE, não remove) → injeta → poll → posta no
//        Chatwoot → SÓ ENTÃO ack (LTRIM). Se qualquer passo falhar, a mensagem
//        continua na fila pro próximo tick. (antes: LTRIM antes do post = perda)
//   P1 — entrega própria (inline poll+post), NÃO depende do bia-postback (que
//        filtra sessions por created_at<35min → 2º balão somia em sessão antiga).
//   P1 — reindexIfRemaining: msg que chega durante o drain re-entra no índice.
//   P2 — drain_lock SETNX por conv (evita 2 execuções drenarem a mesma conv).
//   Bônus — revalida bia_teste lendo labels E cached_label_list (shape Chatwoot).
//
// Dedup CRUZADO: usa o MESMO BLOB_PREFIX e a MESMA dedup key (agent_{sid}_{idx})
// do bia-postback. Se um já postou, o outro vê alreadyPosted e pula → zero dup.

import { list, put, del } from '@vercel/blob';
import { skipIfNotPrimary } from '../_lib/primary-project.js';
import { resolveSessionForThread, setActiveSession } from '../_lib/session-reuse.js';
import { responseOrFallbackFromEvents } from '../_lib/bia-client-response.js';
import { shouldSendNow } from '../_lib/send-window.js';
import { markBiaOutgoing, armCascade, buildSnapshotFromContext } from '../_lib/cascade.js';
import { getRecentCtwaContextForPhone } from '../_lib/followup-ctwa.js';
import { kvClaim, kvRelease } from '../_lib/kv-rate-limit.js';
import {
  listPendingConvs,
  peekPending,
  ackPending,
  reindexIfRemaining,
  setInjected,
  getInjected,
  clearInjected,
  clearPendingAll,
  clearPendingIndex,
  bumpDrainCycle,
} from '../_lib/pending-queue.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://chatwoot-production-af5f.up.railway.app';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const SHADOW_LABEL = (process.env.BIA_SHADOW_LABEL || 'bia_teste').toLowerCase();
const BLOB_PREFIX = 'bia/postback/posted/'; // MESMO do bia-postback → dedup cruzado
const MAX_PER_RUN = 10;
const RUN_BUDGET_MS = 48000; // não inicia nova conv depois disso (maxDuration 60s)
const POLL_TICK_MS = 2500;

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

async function fetchEvents(sid) {
  const resp = await fetch(`${ANTHROPIC_BASE}/sessions/${sid}/events?limit=300`, {
    headers: anthropicHeaders(), signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Anthropic events HTTP ${resp.status}`);
  const body = await resp.json();
  return body.data || [];
}

function countIdleEvents(events = []) {
  return events.filter((e) => e?.type === 'session.status_idle').length;
}

function latestSessionIsRunning(events = []) {
  const status = [...events].reverse().find((e) => (
    e?.type === 'session.status_running' ||
    e?.type === 'session.thread_status_running' ||
    e?.type === 'session.status_idle' ||
    e?.type === 'session.thread_status_idle'
  ));
  return status?.type === 'session.status_running' || status?.type === 'session.thread_status_running';
}

function dedupePendingItems(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = item?.msg_id ? String(item.msg_id) : null;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(item);
  }
  return out;
}

async function postTurn(sid, telefone, text) {
  const content = `(TELEFONE_CLIENTE: +${telefone}) ${text}`;
  const resp = await fetch(`${ANTHROPIC_BASE}/sessions/${sid}/events`, {
    method: 'POST', headers: anthropicHeaders(),
    body: JSON.stringify({ events: [{ type: 'user.message', content: [{ type: 'text', text: content }] }] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    const d = await resp.text().catch(() => '');
    throw new Error(`Anthropic event POST HTTP ${resp.status}: ${d.slice(0, 200)}`);
  }
  return true;
}

function stripWhatsAppMarkdown(text) {
  return String(text || '')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/^---+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const getDedupKey = (sid, idx) =>
  (idx !== null && idx !== undefined && idx >= 0) ? `agent_${sid}_${idx}` : `sess_${sid}`;

async function alreadyPosted(dedupKey) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return false;
  try {
    const { blobs } = await list({ prefix: `${BLOB_PREFIX}${dedupKey}` });
    return blobs.length > 0;
  } catch (e) { console.error(`[BIA-DRAIN-DEDUP] ${dedupKey}: ${e?.message || e}`); return false; }
}

async function markPosted(dedupKey, payload) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    await put(`${BLOB_PREFIX}${dedupKey}.json`, JSON.stringify(payload), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
    });
  } catch (e) { console.error(`[BIA-DRAIN-MARK] ${dedupKey}: ${e?.message || e}`); }
}

async function deleteMarker(dedupKey) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const { blobs } = await list({ prefix: `${BLOB_PREFIX}${dedupKey}` });
    for (const b of blobs) await del(b.url);
  } catch (e) { console.error(`[BIA-DRAIN-DEL] ${dedupKey}: ${e?.message || e}`); }
}

async function postChatwoot(convId, content) {
  const resp = await fetch(
    `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${convId}/messages`,
    { method: 'POST', headers: { 'api_access_token': process.env.CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, message_type: 'outgoing' }) }
  );
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Chatwoot ${resp.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

async function armFollowupAfterDrain(convId, sid, clean, marker = {}) {
  if (process.env.FOLLOWUP_ENABLED !== '1') return;
  try {
    const snapshot = buildSnapshotFromContext(null, clean);
    snapshot.telefone = marker.telefone || null;
    const ctwa = await getRecentCtwaContextForPhone(marker.telefone || null);
    snapshot.is_ctwa = ctwa.is_ctwa === true;
    if (ctwa.template_free_until_at) snapshot.template_free_until_at = ctwa.template_free_until_at;
    await armCascade(convId, sid, snapshot);
  } catch (e) {
    console.error(`[FU-ARM-DRAIN] conv=${convId} ${e?.message || e}`);
  }
}

// Revalida bia_teste lendo labels (array) E cached_label_list (CSV) — shapes do Chatwoot.
async function stillBiaTeste(conv) {
  try {
    const resp = await fetch(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conv}`,
      { headers: { 'api_access_token': process.env.CHATWOOT_API_TOKEN }, signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) return { unknown: true };
    const body = await resp.json();
    const c = body?.payload || body?.data || body || {};
    const fromArray = Array.isArray(c.labels) ? c.labels : [];
    const fromCsv = typeof c.cached_label_list === 'string' ? c.cached_label_list.split(',') : [];
    const labels = [...fromArray, ...fromCsv].map((l) => String(l).trim().toLowerCase()).filter(Boolean);
    return { has: labels.includes(SHADOW_LABEL) };
  } catch (e) { return { unknown: true, error: String(e?.message || e) }; }
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (skipIfNotPrimary(res, 'bia-pending-drain')) return;
  if (!process.env.ANTHROPIC_API_KEY_ICELASER || !process.env.CHATWOOT_API_TOKEN) {
    return res.status(500).json({ error: 'missing_env' });
  }

  const runStart = Date.now();
  const pollDeadline = runStart + RUN_BUDGET_MS;
  const stats = { scanned: 0, delivered: 0, busy: 0, no_label: 0, no_session: 0, loop_guard: 0, lock_busy: 0, poll_timeout: 0, errors: 0 };

  let convs = [];
  try { convs = await listPendingConvs(MAX_PER_RUN, 0); }
  catch (e) { return res.status(200).json({ ok: false, error: 'list_failed', detail: String(e?.message || e) }); }

  for (const conv of convs) {
    if (Date.now() > pollDeadline) break; // sem budget pra mais uma conv neste tick
    stats.scanned += 1;

    // P2 — drain_lock por conv (evita 2 execuções na mesma conv)
    const drainLockKey = `bia:pending:drain_lock:${conv}`;
    const dl = await kvClaim(drainLockKey, '1', 60);
    if (!dl.ok && !dl.fallback) { stats.lock_busy += 1; continue; }

    const threadLockKey = `rl:thread:${conv}:in_flight`;
    let threadLockAcquired = false;
    let releaseThreadLock = true;
    try {
      // Participa do MESMO lock canônico do handler. Só o drain_lock não basta:
      // sem este SETNX, um webhook novo poderia injetar outro turno na sessão em paralelo.
      const threadLock = await kvClaim(threadLockKey, `pending_${Date.now()}`, 90);
      if (!threadLock.ok && !threadLock.fallback) { stats.busy += 1; continue; }
      threadLockAcquired = threadLock.ok === true && threadLock.fallback !== true;

      // Revalida bia_teste (humano pode ter assumido)
      const label = await stillBiaTeste(conv);
      if (label.unknown) { stats.errors += 1; continue; } // Chatwoot indisponível → retry depois
      if (!label.has) {
        console.log(`[BIA-DRAIN] bia_teste removido conv=${conv} — descarta pendência`);
        await clearPendingAll(conv); stats.no_label += 1; continue;
      }

      // Sessão reusável (após balloon1, setActiveSession renovou TTL)
      const reuse = await resolveSessionForThread(conv);
      if (!reuse.reused || !reuse.sessionId) {
        await clearPendingIndex(conv); stats.no_session += 1; continue;
      }

      // Marker de turno já injetado? (re-entrada após poll timeout — NÃO re-injeta)
      let marker = await getInjected(conv);
      let sid, n, baselineLen, baselineIdleCount;
      if (marker && marker.sid) {
        sid = marker.sid;
        n = marker.n;
        baselineLen = marker.baselineLen || 0;
        baselineIdleCount = marker.baselineIdleCount || 0;
      } else {
        const peek = await peekPending(conv);
        if (!peek.count) { await clearPendingIndex(conv); continue; }
        const pendingItems = dedupePendingItems(peek.items);
        const telefone = pendingItems.find((i) => i.telefone)?.telefone || '';
        const text = pendingItems.map((i) => i.text).filter(Boolean).join('\n');
        if (!telefone || !text) { await clearPendingIndex(conv); continue; }

        sid = reuse.sessionId;
        n = peek.count;
        const before = await fetchEvents(sid);
        if (latestSessionIsRunning(before)) { stats.busy += 1; continue; }
        baselineLen = before.length;
        baselineIdleCount = countIdleEvents(before);

        // Anti-loop conta apenas NOVAS injeções. Re-poll de marker já injetado não
        // pode queimar o contador e descartar mensagem por "entrega lenta".
        const cycle = await bumpDrainCycle(conv);
        if (cycle.exceeded) {
          console.warn(`[BIA-DRAIN] loop guard conv=${conv} cycles=${cycle.count} — limpa pendência`);
          await clearPendingAll(conv); stats.loop_guard += 1; continue;
        }

        await postTurn(sid, telefone, text); // injeta o lote como turno novo
        await setInjected(conv, { sid, n, baselineLen, baselineIdleCount, telefone, ts: Date.now() });
        marker = { sid, n, baselineLen, baselineIdleCount, telefone };
      }

      // Poll: espera o turno novo completar (idle + agent.message além do baseline)
      let events = [];
      let ready = false;
      while (Date.now() < pollDeadline) {
        events = await fetchEvents(sid);
        const idleCount = countIdleEvents(events);
        const hasNewIdle = idleCount > baselineIdleCount;
        const fresh = events.slice(baselineLen);
        const hasNewAgentMessage = fresh.some((e) => e.type === 'agent.message');
        if (hasNewIdle && hasNewAgentMessage) {
          ready = true; break;
        }
        await new Promise((r) => setTimeout(r, POLL_TICK_MS));
      }
      if (!ready) {
        stats.poll_timeout += 1;
        releaseThreadLock = false; // turno pode ainda estar rodando; deixa TTL segurar a thread
        continue;
      } // marker fica; próximo tick só entrega

      // Extrai a resposta do turno novo (última segura) + entrega
      const extracted = responseOrFallbackFromEvents(events, { baselineEventCount: baselineLen, preferSafeCandidate: 'last' });
      const clean = extracted.ok ? stripWhatsAppMarkdown(extracted.text) : '';
      if (!clean) { stats.errors += 1; continue; } // marker fica; tenta de novo

      const dedupKey = getDedupKey(sid, extracted.agentMsgIdx);
      if (await alreadyPosted(dedupKey)) {
        // bia-postback já entregou esse turno → só limpa a fila.
        await ackPending(conv, n); await reindexIfRemaining(conv); await clearInjected(conv);
        stats.delivered += 1; continue;
      }
      const gate = shouldSendNow({ session_type: 'reactive_reply' });
      if (!gate.ok) continue; // fora da janela → marker fica, entrega quando abrir

      await markPosted(dedupKey, { session_id: sid, conv_id: conv, posted_by: 'pending_drain_claiming', dedup_key: dedupKey, posted_at: new Date().toISOString() });
      try {
        const posted = await postChatwoot(conv, clean);
        await markPosted(dedupKey, { session_id: sid, conv_id: conv, chatwoot_msg_id: posted.id, agent_msg_idx: extracted.agentMsgIdx, posted_by: 'pending_drain_confirmed', dedup_key: dedupKey, posted_at: new Date().toISOString() });
        try { await markBiaOutgoing(conv); } catch { /* non-fatal */ }
        try { await setActiveSession(conv, sid); } catch { /* renova TTL — non-fatal */ }
        await armFollowupAfterDrain(conv, sid, clean, marker);
        // P0 — ack SÓ AGORA (entrega confirmada). P1 — reindexa se sobrou msg do meio do drain.
        await ackPending(conv, n);
        await reindexIfRemaining(conv);
        await clearInjected(conv);
        stats.delivered += 1;
        console.log(`[BIA-DRAIN] conv=${conv} sid=${sid} msgs=${n} entregue msg_id=${posted.id}`);
      } catch (postErr) {
        await deleteMarker(dedupKey); // libera pra retry
        stats.errors += 1;
        console.error(`[BIA-DRAIN] post falhou conv=${conv}: ${postErr?.message || postErr} — pendência mantida`);
        // NÃO faz ack: mensagem continua na fila; marker fica; próximo tick re-entrega.
      }
    } catch (e) {
      stats.errors += 1;
      console.error(`[BIA-DRAIN] conv=${conv} erro: ${e?.message || e} — pendência mantida`);
    } finally {
      if (threadLockAcquired && releaseThreadLock) await kvRelease(threadLockKey);
      await kvRelease(drainLockKey);
    }
  }

  return res.status(200).json({ ok: true, ...stats });
}
