/**
 * /api/cron/daily-report — Relatório diário de leads e performance
 * Executado automaticamente pela Vercel Cron: 11h e 23h UTC (8h e 20h Recife)
 *
 * O que faz:
 *   - Conta leads pending e converted no Blob
 *   - Calcula taxa de conversão do dia
 *   - Envia resumo por email
 */

import { list } from '@vercel/blob';
import { sanitizeHeader } from '../_lib/security.js';

const EMAIL_FROM  = process.env.EMAIL_FROM  || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS  = process.env.EMAIL_PASS;
const EMAIL_TO    = (process.env.EMAIL_TO   || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');
const CRON_SECRET = process.env.CRON_SECRET;

async function countBlobs(prefix, sinceMs = 0) {
  // Lista TODOS os blobs do prefix (paginado) e filtra por uploadedAt >= sinceMs.
  // sinceMs=0 conta todos (comportamento anterior — fallback ou acumulado total).
  let count = 0;
  let cursor;
  do {
    const result = await list({ prefix, cursor, limit: 1000 });
    for (const blob of result.blobs) {
      const uploaded = blob.uploadedAt ? new Date(blob.uploadedAt).getTime() : 0;
      if (uploaded >= sinceMs) count++;
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return count;
}

async function sendReport(pending, converted, period, totals = {}) {
  if (!EMAIL_PASS) {
    console.warn('[CRON] EMAIL_PASS não configurado — email ignorado');
    return;
  }
  const nodemailer = (await import('nodemailer')).default;
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_FROM, pass: EMAIL_PASS } });
  const total = pending + converted;
  const taxa  = total > 0 ? ((converted / total) * 100).toFixed(1) : '0';
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' });
  const { pendingTotal = 0, convertedTotal = 0 } = totals;

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
    <div style="background:#1a1a2e;padding:20px;border-radius:8px 8px 0 0">
      <h2 style="color:#fff;margin:0">📊 Relatório ${period} — IceLaser</h2>
      <p style="color:#aaa;margin:5px 0 0">${agora}</p>
    </div>
    <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee">
      <h3 style="margin:0 0 12px;color:#333">Últimas 24h</h3>
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:12px 8px;color:#666">Leads pendentes</td>
          <td style="padding:12px 8px;text-align:right"><strong style="font-size:20px">${pending}</strong></td>
        </tr>
        <tr style="background:#f0f0f0">
          <td style="padding:12px 8px;color:#666">Leads convertidos</td>
          <td style="padding:12px 8px;text-align:right"><strong style="font-size:20px;color:#25D366">${converted}</strong></td>
        </tr>
        <tr>
          <td style="padding:12px 8px;color:#666">Taxa de conversão</td>
          <td style="padding:12px 8px;text-align:right"><strong style="font-size:20px;color:#1877f2">${taxa}%</strong></td>
        </tr>
      </table>
      <h3 style="margin:16px 0 12px;color:#333;font-size:13px">Histórico acumulado</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr>
          <td style="padding:8px;color:#999">Pendentes</td>
          <td style="padding:8px;text-align:right;color:#999">${pendingTotal}</td>
        </tr>
        <tr style="background:#fafafa">
          <td style="padding:8px;color:#999">Convertidos</td>
          <td style="padding:8px;text-align:right;color:#999">${convertedTotal}</td>
        </tr>
      </table>
    </div>
  </div>`;

  // sanitizeHeader defense-in-depth — period é interno ('Manhã'/'Noite'),
  // converted é number, mas pattern consistente previne future regressions.
  await t.sendMail({
    from: `"IceLaser Bot" <${EMAIL_FROM}>`,
    to: EMAIL_TO.join(','),
    subject: sanitizeHeader(`📊 Relatório ${period} — ${converted} conversões 24h | IceLaser`, 200),
    html,
  });
}

export default async function handler(req, res) {
  // Vercel Cron envia Authorization: Bearer <CRON_SECRET>.
  // SEGURANÇA: se CRON_SECRET não estiver configurado, REJEITAR acesso.
  // Antes: `if (CRON_SECRET && ...)` pulava auth quando env var ausente =
  // endpoint exposto publicamente. Agora exige secret em qualquer caso.
  if (!CRON_SECRET) {
    console.error('[CRON] CRON_SECRET não configurado — endpoint bloqueado');
    return res.status(503).json({ error: 'Cron secret not configured' });
  }
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Janela 24h pra report não-cumulativo (antes contava TODO histórico).
    const nowMs = Date.now();
    const last24hMs = nowMs - 24 * 60 * 60 * 1000;

    const [pending24h, converted24h, pendingTotal, convertedTotal] = await Promise.all([
      process.env.BLOB_READ_WRITE_TOKEN ? countBlobs('leads/pending/', last24hMs) : Promise.resolve(0),
      process.env.BLOB_READ_WRITE_TOKEN ? countBlobs('leads/converted/', last24hMs) : Promise.resolve(0),
      process.env.BLOB_READ_WRITE_TOKEN ? countBlobs('leads/pending/') : Promise.resolve(0),
      process.env.BLOB_READ_WRITE_TOKEN ? countBlobs('leads/converted/') : Promise.resolve(0),
    ]);

    const hour = new Date().getUTCHours();
    const period = hour < 12 ? 'Manhã' : 'Noite';

    console.log(`[CRON] ${period} 24h: pending=${pending24h} converted=${converted24h} | total hist: pending=${pendingTotal} converted=${convertedTotal}`);

    await sendReport(pending24h, converted24h, period, { pendingTotal, convertedTotal });

    return res.status(200).json({ ok: true, pending24h, converted24h, pendingTotal, convertedTotal });
  } catch (err) {
    console.error('[CRON]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
