// api/cron/funnel-signal-monitor.js
//
// V5: monitora o sintoma que derrubou performance em abril:
// cliques/LPVs seguem fortes, mas conversas iniciadas por clique despencam.
// Não envia email por enquanto; grava alerta em Blob para auditoria read-only.

import { list, put } from '@vercel/blob';
import { brtISO, isVercelCron } from '../_lib/time.js';
import { skipIfNotPrimary } from '../_lib/primary-project.js';

const GRAPH_BASE = 'https://graph.facebook.com/v25.0';
const LOOKBACK_DAYS = 14;
const RECENT_DAYS = 3;
const BASELINE_DAYS = 7;
const MIN_CLICKS = 30;
const MIN_BASELINE_MSG_RATE = 0.005;
const DEGRADATION_THRESHOLD = 0.5;
const COOLDOWN_MS = 12 * 60 * 60 * 1000;

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  return isVercelCron(req) || (!!expected && auth === `Bearer ${expected}`);
}

function normalizeAdAccountId(raw) {
  if (!raw) return null;
  const id = String(raw).trim();
  if (!id) return null;
  return id.startsWith('act_') ? id : `act_${id}`;
}

function brtDateOffset(daysAgo) {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Recife',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function numeric(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function actionCount(actions, candidates) {
  const wanted = new Set(candidates);
  return (actions || []).reduce((sum, item) => {
    return wanted.has(item?.action_type) ? sum + numeric(item.value) : sum;
  }, 0);
}

function normalizeDay(row) {
  const actions = row.actions || [];
  const inlineClicks = numeric(row.inline_link_clicks) || actionCount(actions, ['link_click']);
  const msgStarted = actionCount(actions, [
    'onsite_conversion.messaging_conversation_started_7d',
    'onsite_conversion.messaging_conversation_started',
    'messaging_conversation_started_7d',
  ]);
  const leads = actionCount(actions, [
    'lead',
    'onsite_conversion.lead_grouped',
    'offsite_conversion.fb_pixel_lead',
  ]);
  return {
    date: row.date_start,
    spend: numeric(row.spend),
    inline_link_clicks: inlineClicks,
    messaging_conversation_started_7d: msgStarted,
    lead: leads,
    msg_per_click: inlineClicks > 0 ? msgStarted / inlineClicks : 0,
    lead_per_click: inlineClicks > 0 ? leads / inlineClicks : 0,
  };
}

function sum(days, field) {
  return days.reduce((acc, day) => acc + numeric(day[field]), 0);
}

function weightedRates(days) {
  const clicks = sum(days, 'inline_link_clicks');
  const msgStarted = sum(days, 'messaging_conversation_started_7d');
  const leads = sum(days, 'lead');
  return {
    clicks,
    msg_started: msgStarted,
    lead: leads,
    msg_per_click: clicks > 0 ? msgStarted / clicks : 0,
    lead_per_click: clicks > 0 ? leads / clicks : 0,
  };
}

async function fetchInsights({ accountId, accessToken, since, until }) {
  const params = new URLSearchParams({
    access_token: accessToken,
    level: 'account',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    fields: 'date_start,date_stop,inline_link_clicks,actions,spend',
  });
  const resp = await fetch(`${GRAPH_BASE}/${accountId}/insights?${params.toString()}`);
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.error) {
    const message = json.error?.message || `Meta HTTP ${resp.status}`;
    throw new Error(message);
  }
  return (json.data || []).map(normalizeDay).sort((a, b) => a.date.localeCompare(b.date));
}

async function readLastAlert(key) {
  try {
    const found = await list({ prefix: key, limit: 1 });
    if (!found.blobs?.length) return null;
    const resp = await fetch(found.blobs[0].url);
    return await resp.json();
  } catch {
    return null;
  }
}

async function saveAlert(key, payload) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { skipped: 'blob_not_configured' };
  await put(key, JSON.stringify(payload, null, 2), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
  return { saved: true };
}

async function analyzeClinic(clinic) {
  const since = brtDateOffset(LOOKBACK_DAYS - 1);
  const until = brtDateOffset(0);
  const days = await fetchInsights({
    accountId: clinic.accountId,
    accessToken: clinic.accessToken,
    since,
    until,
  });

  const eligible = days.filter((day) => day.inline_link_clicks > 0);
  const recent = eligible.slice(-RECENT_DAYS);
  const baseline = eligible.slice(0, Math.max(0, eligible.length - RECENT_DAYS)).slice(-BASELINE_DAYS);
  const recentStats = weightedRates(recent);
  const baselineStats = weightedRates(baseline);
  const degradation = baselineStats.msg_per_click > 0
    ? 1 - (recentStats.msg_per_click / baselineStats.msg_per_click)
    : 0;
  const leadInflation = baselineStats.lead_per_click > 0
    ? (recentStats.lead_per_click / baselineStats.lead_per_click) - 1
    : 0;

  const enoughVolume = recentStats.clicks >= MIN_CLICKS && baselineStats.clicks >= MIN_CLICKS;
  const alert = enoughVolume
    && baselineStats.msg_per_click >= MIN_BASELINE_MSG_RATE
    && degradation >= DEGRADATION_THRESHOLD;

  const result = {
    clinic: clinic.slug,
    label: clinic.label,
    account_id: clinic.accountId,
    since,
    until,
    alert,
    degradation,
    lead_inflation: leadInflation,
    enough_volume: enoughVolume,
    recent: recentStats,
    baseline: baselineStats,
    days,
  };

  if (!alert) return { ...result, alert_persist: { skipped: 'no_alert' } };

  const key = `alerts/funnel-signal-last-${clinic.slug}.json`;
  const last = await readLastAlert(key);
  if (last?.ts && Date.now() - last.ts < COOLDOWN_MS) {
    return { ...result, alert_persist: { skipped: 'cooldown', last_ts: last.ts } };
  }

  const alertPayload = {
    ts: Date.now(),
    at_brt: brtISO(),
    ...result,
  };
  const persist = await saveAlert(key, alertPayload);
  console.error(`[FUNNEL-SIGNAL] ${clinic.label}: queda ${(degradation * 100).toFixed(0)}% em msg/click recent=${recentStats.msg_per_click.toFixed(4)} baseline=${baselineStats.msg_per_click.toFixed(4)}`);
  return { ...result, alert_persist: persist };
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (skipIfNotPrimary(res, 'funnel-signal-monitor')) return;

  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) return res.status(503).json({ error: 'meta_access_token_not_configured' });

  const clinics = [
    {
      slug: 'recife',
      label: 'Recife',
      accountId: normalizeAdAccountId(process.env.META_AD_ACCOUNT_ID || 'act_790663154114264'),
      accessToken,
    },
    {
      slug: 'jpa',
      label: 'Joao Pessoa',
      accountId: normalizeAdAccountId(process.env.META_AD_ACCOUNT_ID_JPA),
      accessToken,
    },
  ].filter((clinic) => clinic.accountId);

  const results = [];
  for (const clinic of clinics) {
    try {
      results.push(await analyzeClinic(clinic));
    } catch (err) {
      results.push({
        clinic: clinic.slug,
        label: clinic.label,
        account_id: clinic.accountId,
        error: err?.message || String(err),
      });
    }
  }

  return res.status(200).json({
    ok: true,
    at_brt: brtISO(),
    results,
  });
}
