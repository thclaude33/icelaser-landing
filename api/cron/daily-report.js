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

const EMAIL_FROM  = process.env.EMAIL_FROM  || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS  = process.env.EMAIL_PASS;
const EMAIL_TO    = (process.env.EMAIL_TO   || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');
const CRON_SECRET = process.env.CRON_SECRET;

async function countBlobs(prefix) {
  let count = 0;
  let cursor;
  do {
    const result = await list({ prefix, cursor, limit: 100 });
    count += result.blobs.length;
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return count;
}

async function sendReport(pending, converted, period) {
  if (!EMAIL_PASS) {
    console.warn('[CRON] EMAIL_PASS não configurado — email ignorado');
    return;
  }
  const nodemailer = (await import('nodemailer')).default;
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_FROM, pass: EMAIL_PASS } });
  const total = pending + converted;
  const taxa  = total > 0 ? ((converted / total) * 100).toFixed(1) : '0';
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' });

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
    <div style="background:#1a1a2e;padding:20px;border-radius:8px 8px 0 0">
      <h2 style="color:#fff;margin:0">📊 Relatório ${period} — IceLaser</h2>
      <p style="color:#aaa;margin:5px 0 0">${agora}</p>
    </div>
    <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee">
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
    </div>
  </div>`;

  await t.sendMail({
    from: `"IceLaser Bot" <${EMAIL_FROM}>`,
    to: EMAIL_TO.join(','),
    subject: `📊 Relatório ${period} — ${converted} conversões | IceLaser`,
    html,
  });
}

export default async function handler(req, res) {
  // Vercel Cron envia Authorization: Bearer <CRON_SECRET>
  const authHeader = req.headers['authorization'];
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [pending, converted] = await Promise.all([
      process.env.BLOB_READ_WRITE_TOKEN ? countBlobs('leads/pending/')   : Promise.resolve(0),
      process.env.BLOB_READ_WRITE_TOKEN ? countBlobs('leads/converted/') : Promise.resolve(0),
    ]);

    const hour   = new Date().getUTCHours();
    const period = hour < 12 ? 'Manhã' : 'Noite';

    console.log(`[CRON] ${period}: pending=${pending} converted=${converted}`);

    await sendReport(pending, converted, period);

    return res.status(200).json({ ok: true, pending, converted });
  } catch (err) {
    console.error('[CRON]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
