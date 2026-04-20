/**
 * /api/cron/emq-alert — Cron horário: puxa EMQ real-time e alerta se critical.
 *
 * Diferença dos outros crons de EMQ:
 *   - emq-monitor.js (diário 10h BRT): relatório COMPLETO por email (com ou sem alertas)
 *   - emq-realtime.js (HTTP sob demanda): dashboard JSON pra consumo externo
 *   - emq-alert.js (ESTE, horário): SÓ envia alerta SE >=1 evento ficou critical
 *
 * Estratégia de notificação:
 *   1. Slack webhook (preferido se SLACK_WEBHOOK_URL env var setado)
 *   2. Email fallback (usa mesma infra nodemailer do emq-monitor)
 *
 * Anti-spam: salva último alerta no Blob (alerts/emq-last.json) com events e
 * timestamp. Só re-alerta se:
 *   a) Novo evento ficou critical
 *   b) Ou passou >= 6h desde último alerta do mesmo evento (re-lembrança)
 *
 * Thresholds: mesmo map do emq-realtime (Purchase 8.0, Lead 7.0, PV 5.5, etc).
 */

import { put, head } from '@vercel/blob';
import nodemailer from 'nodemailer';
import { PIXEL_ID, GRAPH_BASE } from '../_lib/config.js';
import { brtISO, isVercelCron } from '../_lib/time.js';
import { escapeHtml, sanitizeHeader } from '../_lib/security.js';

const EMAIL_FROM = process.env.EMAIL_FROM || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = (process.env.EMAIL_TO || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL; // opcional

const EMQ_THRESHOLDS = {
  Purchase: 8.0,
  Lead: 7.0,
  LeadSubmitted: 7.0,
  LeadDesqualificado: 7.0,
  CompleteRegistration: 7.0,
  InitiateCheckout: 6.5,
  ViewContent: 6.0,
  PageView: 5.5,
};
const EMQ_MIN_DEFAULT = 5.0;
const REALERT_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h

async function fetchEmq(token) {
  const fields = 'web{event_name,event_match_quality{composite_score},event_coverage{percentage,goal_percentage}}';
  const url = `${GRAPH_BASE}/dataset_quality?dataset_id=${PIXEL_ID}&fields=${encodeURIComponent(fields)}`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  // Fix HIGH AI deep review v2 (b4 emq-alert.js:49): checar response.ok antes
  // de r.json(). Meta retorna HTML em 502/503 → SyntaxError no parse, mensagem
  // inútil no log. Agora: descrever status HTTP explicitamente.
  if (!r.ok) {
    const txt = (await r.text()).substring(0, 200);
    throw new Error(`Meta API ${r.status}: ${txt}`);
  }
  const data = await r.json();
  if (data.error) throw new Error(`Meta API: ${data.error.message}`);
  return data.web || [];
}

function classifyCritical(events) {
  const criticals = [];
  for (const ev of events) {
    const name = ev.event_name;
    const emq = ev.event_match_quality?.composite_score;
    if (emq === null || emq === undefined) continue;
    const threshold = EMQ_THRESHOLDS[name] ?? EMQ_MIN_DEFAULT;
    if (emq < threshold) {
      criticals.push({ event: name, emq, threshold });
    }
  }
  return criticals;
}

/** Blob lock anti-spam: evita re-alertar mesmo evento em <6h. */
async function loadLastAlert() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const meta = await head('alerts/emq-last.json');
    const r = await fetch(meta.url);
    return await r.json();
  } catch { return null; }
}

async function saveLastAlert(criticals) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    // Store é public — usar access:'public' + pathname obscuro (UUID no nome)
    // pra evitar enumeração. alerts/emq-last.json: conteúdo é só {at, events[]}
    // sem PII. Aceitável público.
    await put('alerts/emq-last.json', JSON.stringify({
      at: new Date().toISOString(),
      events: criticals,
    }), {
      access: 'public',
      contentType: 'application/json',
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  } catch (e) {
    console.warn('[EMQ-ALERT] lock save failed:', e.message);
  }
}

function shouldAlert(currentCriticals, lastAlert) {
  if (!lastAlert) return true;
  const lastAt = new Date(lastAlert.at).getTime();
  if (Date.now() - lastAt >= REALERT_WINDOW_MS) return true;  // janela expirou
  // Se surgiu novo evento crítico que não estava na última: alerta.
  const lastEvents = new Set((lastAlert.events || []).map(e => e.event));
  for (const c of currentCriticals) {
    if (!lastEvents.has(c.event)) return true;
  }
  return false;
}

async function sendSlack(criticals) {
  if (!SLACK_WEBHOOK_URL) return false;
  const text = `🔴 *EMQ Alerta IceLaser* (${brtISO()})\n${criticals.map(c =>
    `• *${c.event}*: EMQ ${c.emq} < threshold ${c.threshold}`).join('\n')}`;
  try {
    const r = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return r.ok;
  } catch (e) {
    console.error('[EMQ-ALERT] slack failed:', e.message);
    return false;
  }
}

async function sendEmail(criticals) {
  if (!EMAIL_PASS) return false;
  try {
    const t = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_FROM, pass: EMAIL_PASS },
    });
    const rows = criticals.map(c =>
      `<tr>
        <td style="padding:8px;border:1px solid #ddd;font-weight:bold">${escapeHtml(c.event)}</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:center;color:#c0392b">
          ${escapeHtml(String(c.emq))}
        </td>
        <td style="padding:8px;border:1px solid #ddd;text-align:center">${escapeHtml(String(c.threshold))}</td>
      </tr>`
    ).join('');
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
        <h2 style="color:#c0392b">🔴 EMQ Alerta — IceLaser Pixel</h2>
        <p style="color:#666">${escapeHtml(brtISO())} | Pixel ${escapeHtml(PIXEL_ID)}</p>
        <table style="width:100%;border-collapse:collapse;margin-top:12px">
          <thead>
            <tr style="background:#1a1a2e;color:#fff">
              <th style="padding:8px;text-align:left">Evento</th>
              <th style="padding:8px;text-align:left">EMQ atual</th>
              <th style="padding:8px;text-align:left">Threshold</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:16px">Verifique em
          <a href="https://business.facebook.com/events_manager2/list/pixel/${PIXEL_ID}/diagnostics">Events Manager</a>.
        </p>
      </div>`;
    await t.sendMail({
      from: `"IceLaser EMQ Alert" <${EMAIL_FROM}>`,
      to: EMAIL_TO.join(','),
      subject: sanitizeHeader(`🔴 EMQ Alerta — ${criticals.length} evento(s) crítico(s) | IceLaser`, 200),
      html,
    });
    return true;
  } catch (e) {
    console.error('[EMQ-ALERT] email failed:', e.message);
    return false;
  }
}

export default async function handler(req, res) {
  // Auth: Vercel Cron envia Bearer CRON_SECRET + UA "vercel-cron/1.0"
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'cron_secret_not_configured' });
  }
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const isCron = isVercelCron(req);

  // Token com escopo reduzido (fallback META_ACCESS_TOKEN se não setado)
  const token = process.env.DATASET_QUALITY_API_TOKEN || process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(503).json({ error: 'meta_token_not_configured' });

  try {
    const events = await fetchEmq(token);
    const criticals = classifyCritical(events);

    // Tudo saudável: log short, retorna OK
    if (criticals.length === 0) {
      console.log(`[EMQ-ALERT] ${brtISO()} trigger=${isCron ? 'cron' : 'manual'} healthy total=${events.length}`);
      return res.status(200).json({ ok: true, critical_count: 0 });
    }

    // Anti-spam: checa última alerta
    const lastAlert = await loadLastAlert();
    if (!shouldAlert(criticals, lastAlert)) {
      console.log(`[EMQ-ALERT] ${brtISO()} suppressed (rearmed <6h) critical=${criticals.length}`);
      return res.status(200).json({ ok: true, suppressed: true, critical_count: criticals.length });
    }

    // Dispara notificações
    const slackSent = await sendSlack(criticals);
    const emailSent = await sendEmail(criticals);
    await saveLastAlert(criticals);

    console.log(`[EMQ-ALERT] ${brtISO()} 🔴 ${criticals.length} critical | slack=${slackSent} email=${emailSent}`);
    return res.status(200).json({
      ok: true,
      critical_count: criticals.length,
      criticals,
      slack_sent: slackSent,
      email_sent: emailSent,
    });
  } catch (err) {
    console.error('[EMQ-ALERT]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
