// api/cron/process-wa-pending.js
//
// FIX BUG P0-3 (Codex 17/05/2026): cron replay pra DLQ wa/pending.
//
// Quando webhook /api/whatsapp recebe msg mas forward Chatwoot falha,
// salva payload em wa/pending/. Este cron reenvia a cada 5 min.
//
// Schedule: */5 * * * *  (a cada 5 min)
// Limites: 50 itens por run, 25s timeout total.
// Move: pending → processed (sucesso) | pending atualizado retry_count+1 (falha).

import { list, put, del } from '@vercel/blob';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { skipIfNotPrimary } from '../_lib/primary-project.js';

const MAX_PER_RUN = 50;
const MAX_RETRIES = 10;
const FN_TIMEOUT_MS = 25_000;

// FIX F4 V4.2 (Codex): alert real cooldown 1h via Blob (var local resetava cold start serverless)
const COOLDOWN_HOURS = 1;
const ALERT_BLOB_KEY = 'alerts/wa-pending-last.json';
const EMAIL_FROM = process.env.EMAIL_FROM || 'espacoicelaserrecife2@gmail.com';
const EMAIL_TO = (process.env.EMAIL_TO || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');

async function readLastAlert() {
  try {
    const r = await list({ prefix: ALERT_BLOB_KEY, limit: 1 });
    if (!r.blobs.length) return null;
    const resp = await fetch(r.blobs[0].url);
    return await resp.json();
  } catch { return null; }
}

async function saveLastAlert(payload) {
  try {
    await put(ALERT_BLOB_KEY, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,  // V4.2 Codex: 2º alert pós-cooldown precisa sobrescrever
      contentType: 'application/json',
    });
  } catch (e) {
    console.warn(`[WA-PENDING] saveLastAlert: ${e.message}`);
  }
}

async function sendAlertEmail({ subject, html }) {
  if (!process.env.EMAIL_PASS) return { skipped: 'no_pass' };
  // Cooldown via Blob (Codex: var local resetava cold start)
  const last = await readLastAlert();
  if (last && (Date.now() - (last.ts || 0)) < COOLDOWN_HOURS * 3600 * 1000) {
    return { skipped: 'cooldown' };
  }
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_FROM, pass: process.env.EMAIL_PASS },
    });
    await transporter.sendMail({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject,
      html,
    });
    await saveLastAlert({ ts: Date.now(), subject });
    return { sent: true };
  } catch (e) {
    console.warn(`[WA-PENDING] alert failed: ${e.message}`);
    return { error: e.message };
  }
}

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  return auth === `Bearer ${expected}`;
}

async function forwardToChatwoot(rawPayload) {
  const CHATWOOT_WEBHOOK_URL = process.env.CHATWOOT_WEBHOOK_URL;
  if (!CHATWOOT_WEBHOOK_URL) {
    return { ok: false, status: 0, error: 'no_chatwoot_webhook_url' };
  }
  // FIX P1-B (Codex 17/05/2026): replicar HMAC X-Hub-Signature-256 igual ao forward original
  // em api/whatsapp.js linha 1684. Sem isso o Chatwoot rejeita o replay quando valida assinatura.
  const APP_SECRET = process.env.META_APP_SECRET;
  const body = JSON.stringify(rawPayload);
  const headers = { 'Content-Type': 'application/json' };
  if (APP_SECRET) {
    headers['X-Hub-Signature-256'] = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
  }
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(CHATWOOT_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(tid);
    return { ok: resp.ok, status: resp.status };
  } catch (e) {
    clearTimeout(tid);
    return { ok: false, status: 0, error: String(e?.message || e).slice(0, 150) };
  }
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  // Multi-projeto race guard
  if (skipIfNotPrimary(res, 'process-wa-pending')) return;

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'missing_env', detail: 'BLOB_READ_WRITE_TOKEN not set' });
  }
  if (!process.env.CHATWOOT_WEBHOOK_URL) {
    return res.status(500).json({ error: 'missing_env', detail: 'CHATWOOT_WEBHOOK_URL not set' });
  }

  const stats = { listed: 0, replayed: 0, failed: 0, max_retries: 0, errors: [] };
  const startMs = Date.now();

  try {
    const blobs = await list({ prefix: 'wa/pending/', limit: MAX_PER_RUN });
    stats.listed = blobs.blobs?.length || 0;

    for (const blob of blobs.blobs || []) {
      if (Date.now() - startMs > FN_TIMEOUT_MS) {
        stats.errors.push('timeout_break');
        break;
      }
      try {
        // Fetch payload from blob
        const payloadResp = await fetch(blob.url);
        if (!payloadResp.ok) {
          stats.errors.push({ pathname: blob.pathname, err: 'blob_fetch_failed' });
          continue;
        }
        const payload = await payloadResp.json();
        const retryCount = payload._dlq_meta?.retry_count ?? 0;

        // Check max retries
        if (retryCount >= MAX_RETRIES) {
          // Move pra dead-letter terminal (não-replayable)
          await put(blob.pathname.replace('wa/pending/', 'wa/dead/'), JSON.stringify({
            ...payload,
            _dlq_meta: { ...payload._dlq_meta, dead_at: new Date().toISOString() },
          }), { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
          try { await del(blob.url); } catch { /* swallow */ }
          stats.max_retries += 1;
          continue;
        }

        // Strip _dlq_meta antes de reenviar pro Chatwoot
        const cleanPayload = { ...payload };
        delete cleanPayload._dlq_meta;

        // Reenviar
        const result = await forwardToChatwoot(cleanPayload);
        if (result.ok) {
          // Move pra processed
          await put(blob.pathname.replace('wa/pending/', 'wa/processed/'), JSON.stringify({
            ...payload,
            _dlq_meta: {
              ...(payload._dlq_meta || {}),
              processed_at: new Date().toISOString(),
              total_retries: retryCount,
            },
          }), { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
          try { await del(blob.url); } catch { /* swallow */ }
          stats.replayed += 1;
        } else {
          // Atualizar retry_count + last_error em-place
          const updated = {
            ...cleanPayload,
            _dlq_meta: {
              ...(payload._dlq_meta || {}),
              retry_count: retryCount + 1,
              last_attempt_at: new Date().toISOString(),
              last_status: result.status,
              last_error: result.error || `http_${result.status}`,
            },
          };
          await put(blob.pathname, JSON.stringify(updated), {
            access: 'public',
            addRandomSuffix: false,
            contentType: 'application/json',
          });
          stats.failed += 1;
        }
      } catch (itemErr) {
        stats.errors.push({ pathname: blob.pathname, err: String(itemErr?.message || itemErr).slice(0, 120) });
      }
    }

    const duration_ms = Date.now() - startMs;
    console.log(`[WA-PENDING-CRON] duration=${duration_ms}ms ${JSON.stringify(stats)}`);

    // FIX F4 V4.2 (Codex C6): MAX_PER_RUN=50 limita stats.listed → '>50' nunca dispararia.
    // Threshold >= MAX_PER_RUN sinaliza cap atingido (provavelmente mais aguardando no Blob).
    if (stats.listed >= MAX_PER_RUN) {
      const alertResult = await sendAlertEmail({
        subject: `[ALERT] DLQ wa/pending atingiu cap (${stats.listed} items)`,
        html: `<p>DLQ wa/pending atingiu o limite por run: <b>${stats.listed}</b> items.</p>
               <p>Replayed: ${stats.replayed}, Failed: ${stats.failed}, MaxRetries: ${stats.max_retries}</p>
               <p>Pode haver mais que ${MAX_PER_RUN} aguardando — checar Blob.</p>
               <p>Duration: ${duration_ms}ms</p>`,
      });
      console.log(`[WA-PENDING-CRON] alert: ${JSON.stringify(alertResult)}`);
    }

    return res.status(200).json({ ok: true, duration_ms, stats });
  } catch (err) {
    return res.status(500).json({ error: 'list_failed', detail: String(err?.message || err) });
  }
}
