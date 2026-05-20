// api/cron/bia-followup-cascade.js
// PROMPT 2 — Cron Cascade Follow-up
//
// SCHEDULE: */2 * * * * (a cada 2 min, cobre F1 minimo 4min com tolerância)
//
// LÓGICA:
//   1. Check killswitch (env FOLLOWUP_ENABLED=1 + KV fu:killswitch != "off")
//   2. ZRANGEBYSCORE fu:idx:scheduled 0 NOW LIMIT 50 → conv_ids prontos
//   3. Pra cada conv_id:
//      a) Read state JSON
//      b) Check daily count < 6 (anti-spam)
//      c) Check window 08-20:30 BRT
//      d) Render template via state.snapshot
//      e) POST Chatwoot /messages outgoing
//      f) markBiaOutgoing (anti-collision humana detect)
//      g) Avança step OU migra F1→F2 OU termina cascade
//      h) Update state + ZADD next_scheduled (ou ZREM se fim)
//   4. Retorna stats

import {
  KV_INDEX, KV_KILLSWITCH,
  stateKey, lastBiaOutgoingKey,
  getNextStep, migrateToPhase2, getTemplate, renderTemplate,
  incrDailyCount, getDailyCount, DAILY_MAX_SENDS,
  markBiaOutgoing,
  computeScheduledAt,
} from '../_lib/cascade.js';
import { kvGet, kvSet, kvDel, kvZadd, kvZrem, kvZrangebyscore } from '../_lib/kv-rate-limit.js';
import { shouldSendNow, nextWindowStart, isWithinSendWindow } from '../_lib/send-window.js';
import { skipIfNotPrimary } from '../_lib/primary-project.js';

const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://chatwoot-production-af5f.up.railway.app';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const MAX_PER_RUN = 50;
const TERMINAL_LABELS = new Set([
  'compra_realizada',
  '💰_compra_realizada',
  'compra realizada',
  'purchase',
  'sold',
  'desqualificado',
  '❌_desqualificado',
  'disqualified',
  'unqualified',
  'lead_quente',
  '🔥_lead_quente',
  'lead quente',
  'hot_lead',
]);

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  return auth === `Bearer ${expected}`;
}

async function postChatwoot(convId, content) {
  const resp = await fetch(
    `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${convId}/messages`,
    {
      method: 'POST',
      headers: { 'api_access_token': process.env.CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, message_type: 'outgoing' }),
    }
  );
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Chatwoot ${resp.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

export function normalizeChatwootLabels(conversation = {}) {
  const sources = [
    conversation.labels,
    conversation.cached_label_list,
    conversation.payload?.labels,
    conversation.payload?.cached_label_list,
    conversation.data?.labels,
    conversation.data?.cached_label_list,
  ];
  return sources.flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',');
    return [];
  }).map((label) => String(label).trim().toLowerCase()).filter(Boolean);
}

function getConversationStatus(conversation = {}) {
  return conversation.status || conversation.payload?.status || conversation.data?.status || null;
}

function getConversationMessages(conversation = {}) {
  const value = conversation.messages || conversation.payload?.messages || conversation.data?.messages || [];
  return Array.isArray(value) ? value : [];
}

function parseJsonBody(text) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function messageCreatedAtMs(message = {}) {
  const raw = message.created_at || message.createdAt || message.timestamp || null;
  if (typeof raw === 'number') return raw < 1000000000000 ? raw * 1000 : raw;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isIncomingMessage(message = {}) {
  return message.message_type === 0 || message.message_type === 'incoming';
}

function isHumanOutgoingMessage(message = {}) {
  const isOutgoing = message.message_type === 1 || message.message_type === 'outgoing';
  if (!isOutgoing) return false;
  const senderType = String(message.sender?.type || message.sender_type || message.senderType || '').toLowerCase();
  return senderType === 'user' || senderType === 'agent';
}

export function validateFollowupConversation(conversation = {}, state = {}) {
  const status = getConversationStatus(conversation);
  if (status && String(status).toLowerCase() !== 'open') {
    return { ok: false, reason: 'status_not_open', status, cleanup: true };
  }

  const labels = normalizeChatwootLabels(conversation);
  const terminalLabel = labels.find((label) => TERMINAL_LABELS.has(label));
  if (terminalLabel) {
    return { ok: false, reason: 'terminal_label', label: terminalLabel, cleanup: true };
  }

  const sinceMs = Date.parse(state.last_step_sent_at || state.started_at || 0);
  if (!Number.isNaN(sinceMs) && sinceMs > 0) {
    const messages = getConversationMessages(conversation);
    const incoming = messages.find((m) => isIncomingMessage(m) && messageCreatedAtMs(m) > sinceMs);
    if (incoming) {
      return { ok: false, reason: 'incoming_after_followup_state', message_id: incoming.id, cleanup: true };
    }
    const humanOutgoing = messages.find((m) => isHumanOutgoingMessage(m) && messageCreatedAtMs(m) > sinceMs);
    if (humanOutgoing) {
      return { ok: false, reason: 'human_outgoing_after_followup_state', message_id: humanOutgoing.id, cleanup: true };
    }
  }

  return { ok: true, status: status || 'unknown', labels };
}

async function fetchChatwootMessages(convId) {
  const resp = await fetch(
    `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${convId}/messages`,
    {
      headers: { 'api_access_token': process.env.CHATWOOT_API_TOKEN },
    }
  );
  const text = await resp.text();
  const body = parseJsonBody(text);
  if (!resp.ok) {
    return { ok: false, status: resp.status, detail: text.slice(0, 200), not_found: resp.status === 404 };
  }
  const messages = body?.payload || body?.data || body?.messages;
  if (!Array.isArray(messages)) {
    return { ok: false, status: resp.status, detail: 'invalid_messages_payload', not_found: false };
  }
  return { ok: true, messages };
}

export async function fetchChatwootConversation(convId) {
  try {
    const resp = await fetch(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${convId}`,
      {
        headers: { 'api_access_token': process.env.CHATWOOT_API_TOKEN },
      }
    );
    const text = await resp.text();
    const body = parseJsonBody(text);
    if (!resp.ok) {
      return { ok: false, status: resp.status, detail: text.slice(0, 200), not_found: resp.status === 404 };
    }

    const messagesResult = await fetchChatwootMessages(convId);
    if (!messagesResult.ok) {
      return {
        ok: false,
        status: messagesResult.status,
        detail: `messages_fetch_failed: ${messagesResult.detail}`,
        not_found: messagesResult.not_found,
      };
    }

    const conversation = body?.payload || body?.data || body;
    return { ok: true, conversation: { ...conversation, messages: messagesResult.messages } };
  } catch (err) {
    return { ok: false, status: 0, detail: String(err?.message || err), network_error: true };
  }
}

export function isKvWriteDegraded(result) {
  return !result || result.ok === false || result.fallback === true;
}

function recordKvPersistenceWarning(stats, convId, action, results) {
  const degraded = Object.entries(results).filter(([, result]) => isKvWriteDegraded(result));
  if (degraded.length === 0) return false;
  stats.kv_persistence_warnings += 1;
  stats.details.push({
    conv: convId,
    action,
    degraded_writes: degraded.map(([name, result]) => ({
      name,
      ok: result?.ok,
      fallback: result?.fallback,
      error: result?.error,
    })),
  });
  console.error(`[FU-KV-DEGRADED] conv=${convId} action=${action} writes=${degraded.map(([name]) => name).join(',')}`);
  return true;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  // Multi-projeto race guard (incidente conv 510 16/05/2026 — 3 projetos disparavam
  // mesma conv em paralelo causando rajada de 6 msgs). Apenas primary project executa.
  if (skipIfNotPrimary(res, 'bia-followup-cascade')) return;

  const stats = {
    enabled: process.env.FOLLOWUP_ENABLED === '1',
    candidates: 0,
    sent: 0,
    skipped_daily_limit: 0,
    skipped_window: 0,
    migrated_to_f2: 0,
    f1_backlog_reset_to_f2: 0,
    finished: 0,
    errors: 0,
    cleaned_orphans: 0,
    skipped_revalidation: 0,
    kv_persistence_warnings: 0,
    details: [],
  };

  // 1. Kill switch checks
  if (process.env.FOLLOWUP_ENABLED !== '1') {
    return res.status(200).json({ ok: true, stats, reason: 'env_disabled' });
  }
  const ks = await kvGet(KV_KILLSWITCH);
  if (ks.ok && ks.value === 'off') {
    return res.status(200).json({ ok: true, stats, reason: 'runtime_killswitch' });
  }
  if (!process.env.CHATWOOT_API_TOKEN) {
    return res.status(500).json({ error: 'missing_env_chatwoot' });
  }

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    // 2. Pick candidates with scheduled_at <= now
    const range = await kvZrangebyscore(KV_INDEX, 0, nowSec, MAX_PER_RUN);
    const convIds = range.members || [];
    stats.candidates = convIds.length;

    for (const convId of convIds) {
      try {
        // 3a. Read state
        const stateR = await kvGet(stateKey(convId));
        if (!stateR.ok || !stateR.value) {
          // Orfão no index — limpa (cenário race: crm-webhook fez DEL state mas ZREM index falhou OR não-atomic)
          await kvZrem(KV_INDEX, convId);
          stats.cleaned_orphans += 1;
          stats.details.push({ conv: convId, action: 'cleanup_orphan', reason: 'state_null' });
          console.log(`[FU-ORPHAN-CLEANUP] conv=${convId} reason=state_null`);
          continue;
        }
        let state;
        try { state = JSON.parse(stateR.value); }
        catch {
          await kvZrem(KV_INDEX, convId);
          await kvDel(stateKey(convId));
          stats.details.push({ conv: convId, action: 'state_corrupt_purge' });
          continue;
        }

        // 3a-bis. F1 BACKLOG DETECTOR (cravado 16/05/2026 após incidente conv 510)
        // Se cliente entrou tarde da noite (started_at < ontem), cron acorda na janela
        // 08:00 BRT com scheduled_at antigo. Sem este guard, cron queima F1[0..N] em
        // rajada (1 step por tick) até bater daily_limit=6. Solução: se F1 com started>8h
        // OU scheduled_lag>1h → migrar direto pra F2 step 0 com NOVO started_at=NOW.
        // F2[0]=D+1 10:00 BRT (1 msg), F2[1]=D+1 14:30, F2[2]=D+1 19:00 (espaçado natural).
        if (state.phase === 1) {
          const startedAgeMs = Date.now() - Date.parse(state.started_at);
          const scheduledLagMs = Date.now() - Date.parse(state.scheduled_at);
          const F1_BACKLOG_STARTED_THRESHOLD_MS = 8 * 3600 * 1000;  // 8h
          const F1_BACKLOG_SCHEDULED_THRESHOLD_MS = 1 * 3600 * 1000; // 1h

          if (startedAgeMs > F1_BACKLOG_STARTED_THRESHOLD_MS ||
              scheduledLagMs > F1_BACKLOG_SCHEDULED_THRESHOLD_MS) {
            const nowMs = Date.now();
            state.started_at = new Date(nowMs).toISOString();
            state.phase = 2;
            state.step = 0;
            const migratedDate = computeScheduledAt(2, 0, nowMs);
            state.scheduled_at = migratedDate.toISOString();
            await kvSet(stateKey(convId), JSON.stringify(state), 30 * 24 * 3600);
            await kvZadd(KV_INDEX, Math.floor(migratedDate.getTime() / 1000), convId);
            stats.f1_backlog_reset_to_f2 += 1;
            stats.details.push({
              conv: convId,
              action: 'f1_backlog_reset_to_f2',
              started_age_h: (startedAgeMs / 3600000).toFixed(1),
              scheduled_lag_h: (scheduledLagMs / 3600000).toFixed(1),
              new_scheduled: state.scheduled_at,
            });
            continue;
          }
        }

        // 3b. Daily limit
        const dailyCount = await getDailyCount(convId);
        if (dailyCount >= DAILY_MAX_SENDS) {
          // Reagenda 08:00 dia seguinte
          const next = nextWindowStart(new Date());
          // forçar amanhã se hoje já bateu
          const tomorrowMs = next.getTime() < Date.now() ? next.getTime() + 86400000 : next.getTime();
          state.scheduled_at = new Date(tomorrowMs).toISOString();
          await kvSet(stateKey(convId), JSON.stringify(state), 30 * 24 * 3600);
          await kvZadd(KV_INDEX, Math.floor(tomorrowMs / 1000), convId);
          stats.skipped_daily_limit += 1;
          stats.details.push({ conv: convId, action: 'daily_limit_reagendado', count: dailyCount });
          continue;
        }

        // 3c. Window gate
        const sessionType = state.phase >= 2 ? 'proactive_followup' : 'cascade_intraday';
        const gate = shouldSendNow({ session_type: sessionType });
        if (!gate.ok) {
          // FASE 1 estourou janela → migra direto pra F2 step 0
          if (state.phase === 1) {
            const migrated = migrateToPhase2(state);
            state.phase = migrated.phase;
            state.step = migrated.step;
            state.scheduled_at = migrated.scheduledAt.toISOString();
            await kvSet(stateKey(convId), JSON.stringify(state), 30 * 24 * 3600);
            await kvZadd(KV_INDEX, Math.floor(migrated.scheduledAt.getTime() / 1000), convId);
            stats.migrated_to_f2 += 1;
            stats.details.push({ conv: convId, action: 'f1_window_blew_migrate_f2', new_scheduled: state.scheduled_at });
          } else {
            // FASE 2/3/4 fora janela: reagenda próximo 08:00
            const nextEpoch = Math.floor(Date.parse(gate.next_send_at) / 1000);
            state.scheduled_at = gate.next_send_at;
            await kvSet(stateKey(convId), JSON.stringify(state), 30 * 24 * 3600);
            await kvZadd(KV_INDEX, nextEpoch, convId);
            stats.skipped_window += 1;
            stats.details.push({ conv: convId, action: 'f2plus_window_reagendado', next: gate.next_send_at });
          }
          continue;
        }

        // 3d. Render template
        const template = getTemplate(state.phase, state.step, state.pacote_snapshot);
        if (!template) {
          // Template missing — finish cascade
          await kvDel(stateKey(convId));
          await kvZrem(KV_INDEX, convId);
          stats.finished += 1;
          stats.details.push({ conv: convId, action: 'no_template_finish' });
          continue;
        }
        const rendered = renderTemplate(template, state.nome_snapshot);

        // 3d-bis. Revalidate current Chatwoot state before posting.
        // Webhooks can be delayed/lost during Railway/Chatwoot incidents; this prevents
        // old follow-ups after human reply, terminal label, or closed conversation.
        const cwState = await fetchChatwootConversation(convId);
        if (!cwState.ok) {
          if (cwState.not_found) {
            const zremResult = await kvZrem(KV_INDEX, convId);
            const delResult = await kvDel(stateKey(convId));
            recordKvPersistenceWarning(stats, convId, 'cleanup_orphan_revalidate_404_kv_degraded', { zremResult, delResult });
            stats.cleaned_orphans += 1;
            stats.details.push({ conv: convId, action: 'cleanup_orphan', reason: 'chatwoot_404_revalidate' });
            continue;
          }
          stats.errors += 1;
          stats.details.push({ conv: convId, action: 'revalidate_failed_transient', status: cwState.status, detail: cwState.detail });
          console.warn(`[FU-REVALIDATE-ERROR] conv=${convId} status=${cwState.status} detail=${cwState.detail || '?'}`);
          continue;
        }
        const revalidation = validateFollowupConversation(cwState.conversation, state);
        if (!revalidation.ok) {
          const zremResult = await kvZrem(KV_INDEX, convId);
          const delResult = await kvDel(stateKey(convId));
          recordKvPersistenceWarning(stats, convId, 'revalidation_cleanup_kv_degraded', { zremResult, delResult });
          stats.skipped_revalidation += 1;
          stats.details.push({ conv: convId, action: 'revalidation_skip_cleanup', reason: revalidation.reason, label: revalidation.label, status: revalidation.status });
          console.log(`[FU-REVALIDATE-SKIP] conv=${convId} reason=${revalidation.reason}`);
          continue;
        }

        // 3e. POST Chatwoot
        let posted;
        try {
          posted = await postChatwoot(convId, rendered);
        } catch (postErr) {
          const errMsg = String(postErr?.message || postErr);
          // BUG cleanup (15/05/2026 ~23h45): distinguir 404 explícito (conv deletada permanentemente)
          // vs 5xx/timeout/rate-limit (transitório — Chatwoot down recupera, mantém scheduled retry next cron).
          // Cenário: smoke conv deletada OU race condition crm-webhook clearActive+disarmCascade não-atômico.
          // Antes: loop infinito até TTL 30d. Agora: ZREM auto em 404 + DEL state pra cleanup full.
          const is404 = errMsg.includes('Chatwoot 404') || errMsg.includes('Resource could not be found');
          if (is404) {
            await kvZrem(KV_INDEX, convId);
            await kvDel(stateKey(convId));
            stats.cleaned_orphans += 1;
            stats.details.push({ conv: convId, action: 'cleanup_orphan', reason: 'chatwoot_404' });
            console.log(`[FU-ORPHAN-CLEANUP] conv=${convId} reason=chatwoot_404`);
            continue;
          }
          // 5xx, timeout, rate limit etc → NÃO ZREM (transitório, retry next cron)
          stats.errors += 1;
          stats.details.push({ conv: convId, action: 'post_failed_transient', err: errMsg.slice(0, 100) });
          console.warn(`[FU-POST-ERROR] conv=${convId} transient err=${errMsg.slice(0, 100)}`);
          continue;
        }

        // 3f. Mark Bia outgoing (anti-collision)
        const markOutgoingResult = await markBiaOutgoing(convId);

        // 3g. Increment daily count
        const dailyCountResult = await incrDailyCount(convId);
        recordKvPersistenceWarning(stats, convId, 'post_send_markers_kv_degraded', { markOutgoingResult, dailyCountResult });

        stats.sent += 1;

        // 3h. Advance step
        const next = getNextStep(state);
        if (!next) {
          // Fim cascade
          const delResult = await kvDel(stateKey(convId));
          const zremResult = await kvZrem(KV_INDEX, convId);
          recordKvPersistenceWarning(stats, convId, 'sent_then_finish_kv_degraded', { delResult, zremResult });
          stats.finished += 1;
          stats.details.push({ conv: convId, action: 'sent_then_finish', msg_id: posted?.id, phase: state.phase, step: state.step });
        } else {
          state.phase = next.phase;
          state.step = next.step;
          state.scheduled_at = next.scheduledAt.toISOString();
          state.last_step_sent_at = new Date().toISOString();
          const setResult = await kvSet(stateKey(convId), JSON.stringify(state), 30 * 24 * 3600);
          const zaddResult = await kvZadd(KV_INDEX, Math.floor(next.scheduledAt.getTime() / 1000), convId);
          recordKvPersistenceWarning(stats, convId, 'sent_then_advance_kv_degraded', { setResult, zaddResult });
          stats.details.push({
            conv: convId, action: 'sent_then_advance',
            msg_id: posted?.id, sent_phase: state.phase, sent_step: state.step, // note: já atualizado pra next
            next_scheduled: state.scheduled_at,
          });
        }
      } catch (err) {
        stats.errors += 1;
        stats.details.push({ conv: convId, error: String(err?.message || err).slice(0, 150) });
      }
    }

    return res.status(200).json({ ok: true, stats });
  } catch (err) {
    return res.status(500).json({ error: 'unhandled', detail: String(err?.message || err) });
  }
}
