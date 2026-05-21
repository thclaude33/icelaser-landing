// api/cron/bia-followup-cascade.js
// Bia Follow-up Cascade V5.3 — shadow test.

import {
  KV_INDEX, KV_KILLSWITCH, STATE_TTL_SEC,
  stateKey,
  getNextStep, getTemplate, renderTemplate, getStepConfig,
  incrDailyCount, getDailyCount, DAILY_MAX_SENDS, MAX_SENDS_PER_CASCADE,
  SCHEMA_VERSION,
  markBiaOutgoing,
  scheduleCurrentStepAt,
  migrateToTemplatePhase,
} from '../_lib/cascade.js';
import { kvClaim, kvRelease, kvGet, kvSet, kvDel, kvZadd, kvZrem, kvZrangebyscore } from '../_lib/kv-rate-limit.js';
import { nextWindowStart, isWithinSendWindow } from '../_lib/send-window.js';
import { skipIfNotPrimary } from '../_lib/primary-project.js';
import { sendTemplate } from '../chatwoot-bot/whatsapp.js';

const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://chatwoot-production-af5f.up.railway.app';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const MAX_PER_RUN = 50;
const CHATWOOT_FETCH_TIMEOUT_MS = 12000;
export const FOLLOWUP_CRON_LOCK_TTL_SEC = 180;
export const FOLLOWUP_STEP_SENT_TTL_SEC = STATE_TTL_SEC;
export const FOLLOWUP_BACKLOG_SCHEDULED_THRESHOLD_MS = 1 * 3600 * 1000;

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
      signal: AbortSignal.timeout(CHATWOOT_FETCH_TIMEOUT_MS),
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
  if (message.private === true) return false;
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
      signal: AbortSignal.timeout(CHATWOOT_FETCH_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(CHATWOOT_FETCH_TIMEOUT_MS),
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

function brtMinuteOfDay(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function isBeforeBrtWindow(date) {
  return brtMinuteOfDay(date) < 8 * 60;
}

export function buildFollowupRunLockKey(convId) {
  return `fu:thread:${convId}:run_lock`;
}

export function buildStepSendKey(convId, state = {}) {
  const startedMs = Date.parse(state.started_at || '');
  const startedPart = Number.isNaN(startedMs) ? 'unknown' : String(startedMs);
  return `fu:thread:${convId}:sent_step:${state.schema_version || 0}:${startedPart}:${state.phase}:${state.step}`;
}

export function shouldSkipOverdueTemplateStep(state = {}, nowMs = Date.now(), thresholdMs = FOLLOWUP_BACKLOG_SCHEDULED_THRESHOLD_MS) {
  if (Number(state.phase) !== 2) return false;
  const scheduledMs = Date.parse(state.scheduled_at || '');
  if (Number.isNaN(scheduledMs)) return true;
  return nowMs - scheduledMs > thresholdMs;
}

export function isStateScheduledInFuture(state = {}, nowMs = Date.now(), graceMs = 0) {
  const scheduledMs = Date.parse(state.scheduled_at || '');
  if (Number.isNaN(scheduledMs)) return false;
  return scheduledMs > nowMs + graceMs;
}

export function isRetryableTemplateSendFailure(result = {}) {
  if (!result || result.ok === true) return false;
  if (!result.status) return true;
  if (result.status === 429) return true;
  if (result.status >= 500) return true;
  return result.error?.is_transient === true;
}

async function persistState(convId, state, scheduledAt, stats, action) {
  state.scheduled_at = scheduledAt.toISOString();
  const setResult = await kvSet(stateKey(convId), JSON.stringify(state), STATE_TTL_SEC);
  const zaddResult = await kvZadd(KV_INDEX, Math.floor(scheduledAt.getTime() / 1000), convId);
  recordKvPersistenceWarning(stats, convId, action, { setResult, zaddResult });
}

async function finishCascade(convId, stats, action, extra = {}) {
  const delResult = await kvDel(stateKey(convId));
  const zremResult = await kvZrem(KV_INDEX, convId);
  recordKvPersistenceWarning(stats, convId, `${action}_kv_degraded`, { delResult, zremResult });
  stats.finished += 1;
  stats.details.push({ conv: convId, action, ...extra });
}

async function moveToTemplateOrFinish(convId, state, stats, reason, nowMs = Date.now()) {
  const untilMs = Date.parse(state.template_free_until_at || 0);
  if (state.is_ctwa !== true) {
    stats.template_skipped_no_ctwa += 1;
    await finishCascade(convId, stats, 'finish_no_ctwa_for_template', { reason });
    return;
  }
  if (Number.isNaN(untilMs) || nowMs >= untilMs) {
    stats.template_skipped_70h += 1;
    await finishCascade(convId, stats, 'finish_template_window_expired', { reason });
    return;
  }

  const next = migrateToTemplatePhase(state, nowMs);
  if (!next || next.scheduledAt.getTime() >= untilMs) {
    await finishCascade(convId, stats, 'finish_no_template_slot', { reason });
    return;
  }

  state.phase = next.phase;
  state.step = next.step;
  await persistState(convId, state, next.scheduledAt, stats, `migrate_template_${reason}`);
  stats.migrated_to_template += 1;
  stats.details.push({ conv: convId, action: `migrate_template_${reason}`, next_scheduled: state.scheduled_at });
}

async function skipOverdueTemplateOrFinish(convId, state, stats, reason, nowMs = Date.now()) {
  if (state.is_ctwa !== true) {
    stats.template_skipped_no_ctwa += 1;
    await finishCascade(convId, stats, 'finish_no_ctwa_for_template', { reason });
    return;
  }
  const untilMs = Date.parse(state.template_free_until_at || 0);
  if (Number.isNaN(untilMs) || nowMs >= untilMs) {
    stats.template_skipped_70h += 1;
    await finishCascade(convId, stats, 'finish_template_window_expired', { reason });
    return;
  }

  const next = migrateToTemplatePhase(state, nowMs);
  if (!next || next.scheduledAt.getTime() >= untilMs) {
    await finishCascade(convId, stats, 'finish_no_template_slot', { reason });
    return;
  }

  state.phase = next.phase;
  state.step = next.step;
  await persistState(convId, state, next.scheduledAt, stats, `template_backlog_skip_${reason}`);
  stats.template_backlog_migrated += 1;
  stats.details.push({ conv: convId, action: `template_backlog_skip_${reason}`, next_scheduled: state.scheduled_at });
}

async function revalidateOrCleanup(convId, state, stats) {
  const cwState = await fetchChatwootConversation(convId);
  if (!cwState.ok) {
    if (cwState.not_found) {
      await finishCascade(convId, stats, 'cleanup_orphan', { reason: 'chatwoot_404_revalidate' });
      return { ok: false, cleaned: true };
    }
    stats.errors += 1;
    stats.details.push({ conv: convId, action: 'revalidate_failed_transient', status: cwState.status, detail: cwState.detail });
    console.warn(`[FU-REVALIDATE-ERROR] conv=${convId} status=${cwState.status} detail=${cwState.detail || '?'}`);
    return { ok: false, transient: true };
  }

  const revalidation = validateFollowupConversation(cwState.conversation, state);
  if (!revalidation.ok) {
    await finishCascade(convId, stats, 'revalidation_skip_cleanup', {
      reason: revalidation.reason,
      label: revalidation.label,
      status: revalidation.status,
    });
    stats.skipped_revalidation += 1;
    console.log(`[FU-REVALIDATE-SKIP] conv=${convId} reason=${revalidation.reason}`);
    return { ok: false, cleaned: true };
  }
  return { ok: true };
}

async function advanceAfterSend(convId, state, stats, sentInfo) {
  state.total_sent_count = Number(state.total_sent_count || 0) + 1;
  state.last_step_sent_at = new Date().toISOString();

  const next = getNextStep(state);
  if (!next) {
    await finishCascade(convId, stats, 'sent_then_finish', sentInfo);
    return;
  }

  state.phase = next.phase;
  state.step = next.step;
  await persistState(convId, state, next.scheduledAt, stats, 'sent_then_advance');
  stats.details.push({
    conv: convId,
    action: 'sent_then_advance',
    ...sentInfo,
    next_phase: state.phase,
    next_step: state.step,
    next_scheduled: state.scheduled_at,
  });
}

async function claimStepSend(convId, state, stats) {
  const key = buildStepSendKey(convId, state);
  const claim = await kvClaim(key, new Date().toISOString(), FOLLOWUP_STEP_SENT_TTL_SEC);
  if (!claim.ok && !claim.fallback) {
    stats.skipped_step_idempotency += 1;
    stats.details.push({ conv: convId, action: 'step_already_claimed_skip_send', key });
    return { ok: false, key };
  }
  if (claim.fallback) stats.kv_lock_fallback += 1;
  return { ok: true, key, fallback: claim.fallback === true };
}

async function releaseStepSendClaim(key) {
  if (!key) return { ok: true };
  return kvDel(key);
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (skipIfNotPrimary(res, 'bia-followup-cascade')) return;

  const stats = {
    enabled: process.env.FOLLOWUP_ENABLED === '1',
    candidates: 0,
    sent: 0,
    sent_freeform: 0,
    sent_template: 0,
    skipped_daily_limit: 0,
    skipped_window: 0,
    migrated_to_template: 0,
    f1_backlog_migrated: 0,
    legacy_state_purged: 0,
    skipped_total_limit: 0,
    template_skipped_no_ctwa: 0,
    template_skipped_70h: 0,
    template_backlog_migrated: 0,
    skipped_locked: 0,
    skipped_not_due: 0,
    skipped_step_idempotency: 0,
    template_permanent_failures: 0,
    kv_lock_fallback: 0,
    finished: 0,
    errors: 0,
    cleaned_orphans: 0,
    skipped_revalidation: 0,
    kv_persistence_warnings: 0,
    details: [],
  };

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
    const range = await kvZrangebyscore(KV_INDEX, 0, nowSec, MAX_PER_RUN);
    const convIds = range.members || [];
    stats.candidates = convIds.length;

    for (const convId of convIds) {
      const lockKey = buildFollowupRunLockKey(convId);
      const lock = await kvClaim(lockKey, `run_${Date.now()}`, FOLLOWUP_CRON_LOCK_TTL_SEC);
      if (!lock.ok && !lock.fallback) {
        stats.skipped_locked += 1;
        stats.details.push({ conv: convId, action: 'skip_locked', existing: lock.existing || null });
        continue;
      }
      if (lock.fallback) stats.kv_lock_fallback += 1;

      try {
        const stateR = await kvGet(stateKey(convId));
        if (!stateR.ok || !stateR.value) {
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

        if (!state.schema_version || state.schema_version < SCHEMA_VERSION) {
          await kvZrem(KV_INDEX, convId);
          await kvDel(stateKey(convId));
          stats.legacy_state_purged += 1;
          stats.details.push({ conv: convId, action: 'legacy_state_purged', schema_version: state.schema_version || null });
          console.log(`[FU-LEGACY-PURGE] conv=${convId} schema=${state.schema_version || 'none'}`);
          continue;
        }

        const now = new Date();
        const nowMs = now.getTime();

        if (isStateScheduledInFuture(state, nowMs)) {
          const scheduledAt = new Date(state.scheduled_at);
          await persistState(convId, state, scheduledAt, stats, 'skip_not_due_reindexed');
          stats.skipped_not_due += 1;
          stats.details.push({ conv: convId, action: 'skip_not_due', scheduled_at: state.scheduled_at });
          continue;
        }

        const cfg = getStepConfig(state.phase, state.step);
        if (!cfg || cfg.enabled === false) {
          await finishCascade(convId, stats, 'step_disabled_or_missing', { phase: state.phase, step: state.step });
          continue;
        }

        if (Number(state.total_sent_count || 0) >= MAX_SENDS_PER_CASCADE) {
          stats.skipped_total_limit += 1;
          await finishCascade(convId, stats, 'finish_total_limit', { total_sent_count: state.total_sent_count });
          continue;
        }

        if (state.phase === 1) {
          const scheduledLagMs = nowMs - Date.parse(state.scheduled_at || 0);
          if (scheduledLagMs > FOLLOWUP_BACKLOG_SCHEDULED_THRESHOLD_MS) {
            stats.f1_backlog_migrated += 1;
            await moveToTemplateOrFinish(convId, state, stats, 'f1_scheduled_lag', nowMs);
            continue;
          }
        }

        if (shouldSkipOverdueTemplateStep(state, nowMs)) {
          await skipOverdueTemplateOrFinish(convId, state, stats, 'scheduled_lag', nowMs);
          continue;
        }

        const dailyCount = await getDailyCount(convId);
        if (dailyCount >= DAILY_MAX_SENDS) {
          stats.skipped_daily_limit += 1;
          if (state.phase === 1) {
            await moveToTemplateOrFinish(convId, state, stats, 'daily_limit_phase1', nowMs);
          } else {
            await finishCascade(convId, stats, 'finish_daily_limit_template', { count: dailyCount });
          }
          continue;
        }

        if (state.phase === 1) {
          const freeformExpiresMs = Date.parse(state.freeform_expires_at || 0);
          if (Number.isNaN(freeformExpiresMs) || nowMs >= freeformExpiresMs) {
            await moveToTemplateOrFinish(convId, state, stats, 'freeform_expired', nowMs);
            continue;
          }

          if (!isWithinSendWindow(now)) {
            const next = nextWindowStart(now);
            if (isBeforeBrtWindow(now) && next.getTime() < freeformExpiresMs) {
              const rescheduled = scheduleCurrentStepAt(state, next);
              Object.assign(state, rescheduled);
              await persistState(convId, state, next, stats, 'f1_before_window_reagendado');
              stats.skipped_window += 1;
              stats.details.push({ conv: convId, action: 'f1_before_window_reagendado', next: state.scheduled_at });
            } else {
              await moveToTemplateOrFinish(convId, state, stats, 'f1_after_window', nowMs);
            }
            continue;
          }
        } else if (state.phase === 2) {
          const untilMs = Date.parse(state.template_free_until_at || 0);
          if (state.is_ctwa !== true) {
            stats.template_skipped_no_ctwa += 1;
            await finishCascade(convId, stats, 'finish_no_ctwa_for_template', { phase: state.phase, step: state.step });
            continue;
          }
          if (Number.isNaN(untilMs) || nowMs >= untilMs) {
            stats.template_skipped_70h += 1;
            await finishCascade(convId, stats, 'finish_template_window_expired', { phase: state.phase, step: state.step });
            continue;
          }
          if (!isWithinSendWindow(now)) {
            const next = nextWindowStart(now);
            if (next.getTime() < untilMs) {
              await persistState(convId, state, next, stats, 'template_window_reagendado');
              stats.skipped_window += 1;
              stats.details.push({ conv: convId, action: 'template_window_reagendado', next: state.scheduled_at });
            } else {
              await finishCascade(convId, stats, 'finish_template_window_no_slot', { phase: state.phase, step: state.step });
            }
            continue;
          }
        }

        const revalidation = await revalidateOrCleanup(convId, state, stats);
        if (!revalidation.ok) continue;

        if (cfg.kind === 'freeform') {
          const template = getTemplate(state.phase, state.step);
          if (!template) {
            await finishCascade(convId, stats, 'no_template_finish', { phase: state.phase, step: state.step });
            continue;
          }
          const rendered = renderTemplate(template, state.nome_snapshot);
          const stepClaim = await claimStepSend(convId, state, stats);
          if (!stepClaim.ok) {
            await advanceAfterSend(convId, state, stats, {
              sent_phase: state.phase,
              sent_step: state.step,
              kind: cfg.kind,
              idempotent_skip: true,
            });
            continue;
          }
          const markOutgoingResult = await markBiaOutgoing(convId);
          recordKvPersistenceWarning(stats, convId, 'pre_post_bia_marker_kv_degraded', { markOutgoingResult });
          let posted;
          try {
            posted = await postChatwoot(convId, rendered);
          } catch (postErr) {
            const errMsg = String(postErr?.message || postErr);
            const is404 = errMsg.includes('Chatwoot 404') || errMsg.includes('Resource could not be found');
            if (is404) {
              await releaseStepSendClaim(stepClaim.key);
              await finishCascade(convId, stats, 'cleanup_orphan', { reason: 'chatwoot_404' });
              console.log(`[FU-ORPHAN-CLEANUP] conv=${convId} reason=chatwoot_404`);
              continue;
            }
            await releaseStepSendClaim(stepClaim.key);
            stats.errors += 1;
            stats.details.push({ conv: convId, action: 'post_failed_transient', err: errMsg.slice(0, 100) });
            console.warn(`[FU-POST-ERROR] conv=${convId} transient err=${errMsg.slice(0, 100)}`);
            continue;
          }

          const dailyCountResult = await incrDailyCount(convId);
          recordKvPersistenceWarning(stats, convId, 'post_send_daily_count_kv_degraded', { dailyCountResult });
          stats.sent += 1;
          stats.sent_freeform += 1;
          await advanceAfterSend(convId, state, stats, {
            msg_id: posted?.id,
            sent_phase: state.phase,
            sent_step: state.step,
            kind: cfg.kind,
          });
          continue;
        }

        if (cfg.kind === 'template') {
          if (!cfg.templateName) {
            await finishCascade(convId, stats, 'template_name_missing', { phase: state.phase, step: state.step });
            continue;
          }
          const to = state.telefone || state.phone;
          if (!to) {
            await finishCascade(convId, stats, 'template_phone_missing', { phase: state.phase, step: state.step });
            continue;
          }
          const stepClaim = await claimStepSend(convId, state, stats);
          if (!stepClaim.ok) {
            await advanceAfterSend(convId, state, stats, {
              sent_phase: state.phase,
              sent_step: state.step,
              kind: cfg.kind,
              template: cfg.templateName,
              idempotent_skip: true,
            });
            continue;
          }
          const result = await sendTemplate({ to, templateName: cfg.templateName, language: 'pt_BR' });
          if (!result.ok) {
            const errorText = String(result.error?.message || result.error || result.detail || 'unknown').slice(0, 120);
            if (!isRetryableTemplateSendFailure(result)) {
              stats.errors += 1;
              stats.template_permanent_failures += 1;
              await finishCascade(convId, stats, 'finish_template_permanent_failure', {
                template: cfg.templateName,
                status: result.status || null,
                error: errorText,
              });
              console.warn(`[FU-TEMPLATE-PERMANENT] conv=${convId} template=${cfg.templateName} status=${result.status || '?'} err=${errorText}`);
              continue;
            }

            await releaseStepSendClaim(stepClaim.key);
            stats.errors += 1;
            stats.details.push({
              conv: convId,
              action: 'template_send_failed_transient',
              template: cfg.templateName,
              error: errorText,
            });
            console.warn(`[FU-TEMPLATE-ERROR] conv=${convId} template=${cfg.templateName} err=${JSON.stringify(result.error || result).slice(0, 160)}`);
            continue;
          }

          const dailyCountResult = await incrDailyCount(convId);
          recordKvPersistenceWarning(stats, convId, 'template_send_markers_kv_degraded', { dailyCountResult });
          stats.sent += 1;
          stats.sent_template += 1;
          await advanceAfterSend(convId, state, stats, {
            msg_id: result.messageId,
            sent_phase: state.phase,
            sent_step: state.step,
            kind: cfg.kind,
            template: cfg.templateName,
            dry_run: result.dryRun === true,
          });
        }
      } catch (err) {
        stats.errors += 1;
        stats.details.push({ conv: convId, error: String(err?.message || err).slice(0, 150) });
      } finally {
        if (!lock.fallback) {
          const releaseResult = await kvRelease(lockKey);
          recordKvPersistenceWarning(stats, convId, 'run_lock_release_kv_degraded', { releaseResult });
        }
      }
    }

    return res.status(200).json({ ok: true, stats });
  } catch (err) {
    return res.status(500).json({ error: 'unhandled', detail: String(err?.message || err) });
  }
}
