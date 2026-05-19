/**
 * /api/cron/capi-alerts — Fix VA-5 (AI review Opus 4.6, 23/04/2026).
 *
 * Propósito: detectar CAPI error events em tempo quase-real (horário) e
 * alertar por email. Mantém leitura de erros legados gravados pelo antigo
 * helper WAM, que está em quarentena total no V5.
 *
 * Pipeline:
 *   1. Helpers CAPI persistem erros em Blob `alerts/capi-errors/{ts}-{subcode}-{rand}.json`
 *   2. Este cron (horário) lê blobs da última hora, agrupa por subcode
 *   3. Se count > 0, envia email com tabela de erros + anti-spam 6h
 *
 * Schedule: `5 * * * *` (a cada hora aos 5 min, pra não colidir com emq-alert 45 min).
 *
 * Anti-spam: mesma estratégia do emq-alert.js — Blob lock `alerts/capi-alerts-last.json`
 * armazena últimos subcodes + timestamp. Não re-alerta mesmo subcode em <6h.
 *
 * Alertas CRITICAL esperados (tratar como regressão imediata):
 *   - 2804066: event_name inválido pra action_source (Lead+business_messaging)
 *   - OAuthException code=1: WABA_ID em user_data (Meta v25 rejeita)
 *   - 2804087: ctwa_clid fake/inválido
 *   - 2804116: page_id inválido
 */

import { list, put, head, del } from '@vercel/blob';
import nodemailer from 'nodemailer';
import { brtISO, isVercelCron } from '../_lib/time.js';
import { escapeHtml, sanitizeHeader } from '../_lib/security.js';
import { skipIfNotPrimary } from '../_lib/primary-project.js';

const EMAIL_FROM = () => process.env.EMAIL_FROM || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS = () => process.env.EMAIL_PASS;
const EMAIL_TO = () => (process.env.EMAIL_TO || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');

const LOOKBACK_MS = 60 * 60 * 1000;  // 1h
const REALERT_WINDOW_MS = 6 * 60 * 60 * 1000;  // 6h anti-spam

/**
 * Subcodes conhecidos com classificação de severidade.
 * - CRITICAL: bug de código, precisa fix imediato
 * - WARNING: config/env issue, precisa investigar
 * - INFO: expected em certos cenários (ctwa_clid fake de bot, etc)
 */
const SEVERITY_MAP = {
  2804066: { level: 'CRITICAL', label: 'event_name inválido pra business_messaging' },
  2804071: { level: 'WARNING', label: 'campo obrigatório ausente (page_id/ctwa_clid)' },
  2804087: { level: 'INFO', label: 'ctwa_clid fake/inválido (bot ou fora de janela)' },
  2804116: { level: 'WARNING', label: 'page_id inválido ou desassociado' },
  1: { level: 'CRITICAL', label: 'OAuthException "An unknown error" (campo inesperado em user_data)' },
  100: { level: 'WARNING', label: 'Invalid parameter genérico' },
};

function classify(errorSubcode, errorCode) {
  return SEVERITY_MAP[errorSubcode] || SEVERITY_MAP[errorCode] || { level: 'UNKNOWN', label: 'erro desconhecido' };
}

async function listErrorBlobs() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return [];
  const cutoff = Date.now() - LOOKBACK_MS;
  const errors = [];
  // list() pode ter paginação — começar com limit generoso (1000 default).
  const { blobs } = await list({ prefix: 'alerts/capi-errors/', limit: 1000 });
  for (const blob of blobs) {
    // pathname: alerts/capi-errors/{ts}-{subcode}-{rand}.json
    const match = blob.pathname.match(/alerts\/capi-errors\/(\d+)-/);
    if (!match) continue;
    const ts = parseInt(match[1], 10);
    if (ts < cutoff) continue;  // descarta erros antigos (>1h)
    errors.push({ pathname: blob.pathname, url: blob.url, ts });
  }
  return errors;
}

async function fetchErrorDetails(errorBlobs) {
  // Fetch paralelo em batches de 10 (evitar saturar conexão)
  const details = [];
  for (let i = 0; i < errorBlobs.length; i += 10) {
    const batch = errorBlobs.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(async (b) => {
        const r = await fetch(b.url, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return null;
        return await r.json();
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) details.push(r.value);
    }
  }
  return details;
}

function groupBySubcode(details) {
  const groups = new Map();
  for (const d of details) {
    const key = d.error_subcode || d.error_code || 'unknown';
    if (!groups.has(key)) {
      const sev = classify(d.error_subcode, d.error_code);
      groups.set(key, {
        subcode: key,
        level: sev.level,
        label: sev.label,
        count: 0,
        samples: [],
        last_at: null,
      });
    }
    const g = groups.get(key);
    g.count += 1;
    if (g.samples.length < 3) {
      g.samples.push({
        at: d.at,
        event_name: `${d.event_name_requested}→${d.event_name_sent}`,
        event_id: d.event_id,
        action_source: d.action_source,
        error_message: (d.error_message || '').slice(0, 200),
        fbtrace_id: d.fbtrace_id,
      });
    }
    if (!g.last_at || d.at > g.last_at) g.last_at = d.at;
  }
  // Retorna ordenado por severidade > count
  const order = { CRITICAL: 0, WARNING: 1, UNKNOWN: 2, INFO: 3 };
  return [...groups.values()].sort((a, b) => (order[a.level] - order[b.level]) || (b.count - a.count));
}

async function loadLastAlert() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const meta = await head('alerts/capi-alerts-last.json');
    const r = await fetch(meta.url, { signal: AbortSignal.timeout(5000) });
    return await r.json();
  } catch { return null; }
}

async function saveLastAlert(groups) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    await put('alerts/capi-alerts-last.json', JSON.stringify({
      at: new Date().toISOString(),
      groups: groups.map(g => ({ subcode: g.subcode, count: g.count, level: g.level })),
    }), {
      access: 'public',
      contentType: 'application/json',
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  } catch (e) {
    console.warn('[CAPI-ALERT] lock save failed:', e.message);
  }
}

function shouldAlert(currentGroups, lastAlert) {
  // Só alerta se há pelo menos 1 CRITICAL ou WARNING (INFO não vale alerta)
  const alertable = currentGroups.filter(g => g.level === 'CRITICAL' || g.level === 'WARNING');
  if (alertable.length === 0) return { yes: false, alertable: [] };
  if (!lastAlert) return { yes: true, alertable };

  const lastAt = new Date(lastAlert.at).getTime();
  if (Date.now() - lastAt >= REALERT_WINDOW_MS) return { yes: true, alertable };

  // Se surgiu novo subcode não estava no last: alerta
  const lastSubcodes = new Set((lastAlert.groups || []).map(g => String(g.subcode)));
  for (const g of alertable) {
    if (!lastSubcodes.has(String(g.subcode))) return { yes: true, alertable };
  }
  return { yes: false, alertable };
}

async function sendEmail(alertable, totalErrors) {
  const pass = EMAIL_PASS();
  if (!pass) return false;
  try {
    const t = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_FROM(), pass },
    });
    const rows = alertable.map(g => {
      const sampleRows = g.samples.map(s =>
        `<div style="font-size:12px;color:#666;margin-top:4px">
          ${escapeHtml(s.at)} | ${escapeHtml(s.event_name)} | event_id=${escapeHtml(s.event_id)}
          <br/><em>${escapeHtml(s.error_message)}</em>
          ${s.fbtrace_id ? `<br/>fbtrace: ${escapeHtml(s.fbtrace_id)}` : ''}
        </div>`).join('');
      const bgColor = g.level === 'CRITICAL' ? '#ffe6e6' : '#fff7e6';
      const levelColor = g.level === 'CRITICAL' ? '#c0392b' : '#d68910';
      return `<tr style="background:${bgColor}">
        <td style="padding:12px;border:1px solid #ddd;font-weight:bold;color:${levelColor}">${escapeHtml(g.level)}</td>
        <td style="padding:12px;border:1px solid #ddd">${escapeHtml(String(g.subcode))}</td>
        <td style="padding:12px;border:1px solid #ddd;text-align:center;font-size:18px;font-weight:bold">${g.count}</td>
        <td style="padding:12px;border:1px solid #ddd">
          <strong>${escapeHtml(g.label)}</strong>
          ${sampleRows}
        </td>
      </tr>`;
    }).join('');
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:720px;margin:auto">
        <h2 style="color:#c0392b">🔴 CAPI/WAM Errors — IceLaser</h2>
        <p style="color:#666">${escapeHtml(brtISO())} | Últimos 60 min | <strong>${totalErrors} error(s)</strong></p>
        <table style="width:100%;border-collapse:collapse;margin-top:12px">
          <thead>
            <tr style="background:#1a1a2e;color:#fff">
              <th style="padding:8px;text-align:left">Severidade</th>
              <th style="padding:8px;text-align:left">Subcode</th>
              <th style="padding:8px;text-align:center">Count</th>
              <th style="padding:8px;text-align:left">Descrição + samples</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:16px;font-size:13px;color:#666">
          <strong>CRITICAL</strong> = bug de código, precisa fix imediato.<br/>
          <strong>WARNING</strong> = config/env issue, investigar.<br/>
          Verifique em <a href="https://business.facebook.com/events_manager2/list/pixel/2774496306216737/diagnostics">Events Manager</a>.
        </p>
      </div>`;
    await t.sendMail({
      from: `"IceLaser CAPI Alert" <${EMAIL_FROM()}>`,
      to: EMAIL_TO().join(','),
      subject: sanitizeHeader(`🔴 CAPI/WAM Errors — ${totalErrors} ocorrência(s) | IceLaser`, 200),
      html,
    });
    return true;
  } catch (e) {
    console.error('[CAPI-ALERT] email failed:', e.message);
    return false;
  }
}

/** Limpa blobs de erro processados (>24h) pra não crescer infinito. */
async function cleanupOldErrors() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return 0;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;  // 24h
  try {
    const { blobs } = await list({ prefix: 'alerts/capi-errors/', limit: 1000 });
    let deleted = 0;
    for (const b of blobs) {
      const m = b.pathname.match(/alerts\/capi-errors\/(\d+)-/);
      if (!m) continue;
      if (parseInt(m[1], 10) < cutoff) {
        await del(b.url);
        deleted++;
      }
    }
    return deleted;
  } catch { return 0; }
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'cron_secret_not_configured' });
  }
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  // Cron dedup: skip se não é primary project (evita 3x email alert)
  if (skipIfNotPrimary(res, 'capi-alerts')) return;
  const isCron = isVercelCron(req);

  try {
    // 1. Lista erros da última hora
    const errorBlobs = await listErrorBlobs();
    if (errorBlobs.length === 0) {
      console.log(`[CAPI-ALERT] ${brtISO()} trigger=${isCron ? 'cron' : 'manual'} healthy (0 errors)`);
      // Cleanup oportunista
      const cleaned = await cleanupOldErrors();
      return res.status(200).json({ ok: true, error_count: 0, cleaned });
    }

    // 2. Fetch details + group
    const details = await fetchErrorDetails(errorBlobs);
    const groups = groupBySubcode(details);

    // 3. Anti-spam check
    const lastAlert = await loadLastAlert();
    const { yes: shouldSend, alertable } = shouldAlert(groups, lastAlert);
    if (!shouldSend) {
      console.log(`[CAPI-ALERT] ${brtISO()} suppressed (rearmed <6h) errors=${errorBlobs.length}`);
      return res.status(200).json({ ok: true, suppressed: true, error_count: errorBlobs.length, groups });
    }

    // 4. Send email
    const emailSent = await sendEmail(alertable, errorBlobs.length);
    await saveLastAlert(alertable);
    const cleaned = await cleanupOldErrors();

    console.log(`[CAPI-ALERT] ${brtISO()} 🔴 ${alertable.length} subcode(s) | ${errorBlobs.length} errors | email=${emailSent} cleaned=${cleaned}`);
    return res.status(200).json({
      ok: true,
      error_count: errorBlobs.length,
      alertable_count: alertable.length,
      groups: alertable,
      email_sent: emailSent,
      cleaned,
    });
  } catch (err) {
    console.error('[CAPI-ALERT]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
