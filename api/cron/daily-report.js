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
import { brtPeriod, brtISO } from '../_lib/time.js';
import { skipIfNotPrimary } from '../_lib/primary-project.js';

// Fix MEDIUM AI deep v3 (daily-report.js:15/18): NÃO cache env vars em module scope.
// Vercel instances warm podem viver dias — rotação de CRON_SECRET ou EMAIL_PASS
// exigiria redeploy. Lazy getters evitam caching stale.
function env(name, fallback) { return process.env[name] || fallback; }

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

/**
 * Retorna os N leads mais recentes de um prefix com timestamps.
 * Usado no email pra dar visibilidade mesmo quando contagem 24h é 0
 * (ajuda diagnóstico "cron sempre mostra 0 leads" — se últimos leads
 * são de 2d atrás, signal é baixo volume de form, não bug de contagem).
 */
async function recentBlobs(prefix, limit = 5) {
  const all = [];
  let cursor;
  do {
    const result = await list({ prefix, cursor, limit: 1000 });
    for (const blob of result.blobs) {
      if (blob.uploadedAt) all.push({ pathname: blob.pathname, uploadedAt: blob.uploadedAt });
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return all
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .slice(0, limit);
}

async function sendReport(pending, converted, period, totals = {}) {
  // Fix MEDIUM AI deep v3 (daily-report.js:58): retornar status pra handler saber
  // se email foi enviado ou skipado. Antes return silent + handler retornava 200 ok
  // mesmo sem email. Agora: boolean return + handler inclui `email_sent` na response.
  const pass = env('EMAIL_PASS');
  const from = env('EMAIL_FROM', 'espacoicelaserrecife2@gmail.com');
  const toStr = env('EMAIL_TO', 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com');
  const emailTo = toStr.split(',');
  if (!pass) {
    console.warn('[CRON] EMAIL_PASS não configurado — email ignorado');
    return false;
  }
  const nodemailer = (await import('nodemailer')).default;
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: from, pass } });
  const total = pending + converted;
  const taxa  = total > 0 ? ((converted / total) * 100).toFixed(1) : '0';
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' });
  const { pendingTotal = 0, convertedTotal = 0, recentPending = [], recentConverted = [] } = totals;

  const fmtRecent = (arr) => arr.length === 0
    ? '<tr><td colspan="2" style="padding:6px 8px;color:#aaa;font-style:italic">Nenhum</td></tr>'
    : arr.map(b => {
        const dt = new Date(b.uploadedAt).toLocaleString('pt-BR', {
          timeZone: 'America/Recife',
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        });
        // Extrai firstName do pathname: leads/pending/TIMESTAMP_name.json
        const parts = b.pathname.split('/').pop().replace(/\.json$/, '').split('_');
        const name = parts.slice(-1)[0] || '?';
        return `<tr><td style="padding:4px 8px;color:#666;font-size:12px">${name}</td>
                    <td style="padding:4px 8px;color:#999;font-size:12px;text-align:right">${dt}</td></tr>`;
      }).join('');

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
      <h3 style="margin:16px 0 8px;color:#333;font-size:13px">Últimos 5 leads pendentes</h3>
      <table style="width:100%;border-collapse:collapse">${fmtRecent(recentPending)}</table>
      <h3 style="margin:16px 0 8px;color:#333;font-size:13px">Últimos 5 leads convertidos</h3>
      <table style="width:100%;border-collapse:collapse">${fmtRecent(recentConverted)}</table>
    </div>
  </div>`;

  // sanitizeHeader defense-in-depth — period é interno ('Manhã'/'Noite'),
  // converted é number, mas pattern consistente previne future regressions.
  await t.sendMail({
    from: `"IceLaser Bot" <${from}>`,
    to: emailTo.join(','),
    subject: sanitizeHeader(`📊 Relatório ${period} — ${converted} conversões 24h | IceLaser`, 200),
    html,
  });
  return true;
}

export default async function handler(req, res) {
  // Fix MEDIUM AI deep v3 (daily-report.js:18): lazy-read env (não cache module scope).
  const CRON_SECRET = env('CRON_SECRET');
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
  // Cron dedup: skip se não é primary (evita 6 emails/dia = 2 * 3 projects)
  if (skipIfNotPrimary(res, 'daily-report')) return;

  try {
    // Janela 24h pra report não-cumulativo (antes contava TODO histórico).
    const nowMs = Date.now();
    const last24hMs = nowMs - 24 * 60 * 60 * 1000;

    const hasBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
    const [pending24h, converted24h, pendingTotal, convertedTotal, recentPending, recentConverted] = await Promise.all([
      hasBlob ? countBlobs('leads/pending/', last24hMs) : Promise.resolve(0),
      hasBlob ? countBlobs('leads/converted/', last24hMs) : Promise.resolve(0),
      hasBlob ? countBlobs('leads/pending/') : Promise.resolve(0),
      hasBlob ? countBlobs('leads/converted/') : Promise.resolve(0),
      hasBlob ? recentBlobs('leads/pending/', 5) : Promise.resolve([]),
      hasBlob ? recentBlobs('leads/converted/', 5) : Promise.resolve([]),
    ]);

    // Period via Intl America/Recife — substituiu `getUTCHours() < 12` que
    // funcionava por coincidência dos crons atuais (11 UTC = 8h manhã, 23 UTC
    // = 20h noite) mas quebraria se schedule mudasse pra 2h UTC (=23h BRT = Noite
    // mas getUTCHours=2 → "Manhã").
    const period = brtPeriod();

    // Log detalhado inclui timestamps BRT dos últimos leads.
    const lastPendingTs = recentPending[0]?.uploadedAt || 'none';
    const lastConvertedTs = recentConverted[0]?.uploadedAt || 'none';
    console.log(`[CRON] ${period} (${brtISO()}) 24h: pending=${pending24h} converted=${converted24h} | total hist: pending=${pendingTotal} converted=${convertedTotal} | last_pending=${lastPendingTs} last_converted=${lastConvertedTs}`);

    const emailSent = await sendReport(pending24h, converted24h, period, {
      pendingTotal, convertedTotal, recentPending, recentConverted,
    });

    return res.status(200).json({
      ok: true,
      email_sent: !!emailSent,
      pending24h, converted24h, pendingTotal, convertedTotal,
      last_pending: lastPendingTs,
      last_converted: lastConvertedTs,
    });
  } catch (err) {
    console.error('[CRON]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
