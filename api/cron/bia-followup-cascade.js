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
} from '../_lib/cascade.js';
import { kvGet, kvSet, kvDel, kvZadd, kvZrem, kvZrangebyscore } from '../_lib/kv-rate-limit.js';
import { shouldSendNow, nextWindowStart, isWithinSendWindow } from '../_lib/send-window.js';

const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://chatwoot-production-af5f.up.railway.app';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const MAX_PER_RUN = 50;

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

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const stats = {
    enabled: process.env.FOLLOWUP_ENABLED === '1',
    candidates: 0,
    sent: 0,
    skipped_daily_limit: 0,
    skipped_window: 0,
    migrated_to_f2: 0,
    finished: 0,
    errors: 0,
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
          // Orfão no index — limpa
          await kvZrem(KV_INDEX, convId);
          stats.details.push({ conv: convId, action: 'state_orphan_zrem' });
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

        // 3e. POST Chatwoot
        let posted;
        try {
          posted = await postChatwoot(convId, rendered);
        } catch (postErr) {
          stats.errors += 1;
          stats.details.push({ conv: convId, action: 'post_failed', err: String(postErr?.message || postErr).slice(0, 100) });
          continue;
        }

        // 3f. Mark Bia outgoing (anti-collision)
        await markBiaOutgoing(convId);

        // 3g. Increment daily count
        await incrDailyCount(convId);

        stats.sent += 1;

        // 3h. Advance step
        const next = getNextStep(state);
        if (!next) {
          // Fim cascade
          await kvDel(stateKey(convId));
          await kvZrem(KV_INDEX, convId);
          stats.finished += 1;
          stats.details.push({ conv: convId, action: 'sent_then_finish', msg_id: posted?.id, phase: state.phase, step: state.step });
        } else {
          state.phase = next.phase;
          state.step = next.step;
          state.scheduled_at = next.scheduledAt.toISOString();
          state.last_step_sent_at = new Date().toISOString();
          await kvSet(stateKey(convId), JSON.stringify(state), 30 * 24 * 3600);
          await kvZadd(KV_INDEX, Math.floor(next.scheduledAt.getTime() / 1000), convId);
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
