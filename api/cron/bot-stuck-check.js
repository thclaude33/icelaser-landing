/**
 * /api/cron/bot-stuck-check — Cron passivo: monitor leads travados no bot Welcome WA-RC
 *
 * Objetivo: coletar 1 semana de data sobre quantos leads ficam stuck no bot
 * pra decidir (data-driven) se vale implementar timeout sistêmico (fix C).
 *
 * Comportamento:
 *   - Roda every 30min (vercel.json crons)
 *   - Query Chatwoot Inbox 7: convs com bot_active=true AND last_activity > 30min
 *   - SÓ LOGA contadores + email alerta se count >= 3 simultâneos
 *   - ZERO envio de mensagem ao lead
 *   - ZERO modificação na conversation
 *   - ZERO reativação do bot
 *
 * Anti-spam: salva último alerta no Blob (alerts/bot-stuck-last.json). Só re-alerta
 * se passou >=4h desde último OU se count subiu significativamente.
 *
 * Decisão T+7 dias:
 *   - SE >20% stuck >60min nunca volta → implementar timeout C (threshold real)
 *   - SE <10% → não implementar, ação humana via atendente case-by-case
 *
 * Lições embutidas (de reference_bot_warc_lessons_learned_11_05_2026.md):
 *   - Barbara desprendeu em 48min (NEVER threshold <60min)
 *   - D'Paula desprendeu em 2h45min (lead pode voltar muito tarde)
 *   - Painel Chatwoot ≠ realidade WhatsApp (validar via custom_attrs API)
 */

import { put, head } from '@vercel/blob';
import nodemailer from 'nodemailer';
import { brtISO, isVercelCron } from '../_lib/time.js';
import { escapeHtml, sanitizeHeader } from '../_lib/security.js';
import { skipIfNotPrimary } from '../_lib/primary-project.js';

const CW_URL = 'https://chatwoot-production-af5f.up.railway.app';
const CW_ACCOUNT = '1';
const CW_TOKEN = process.env.CHATWOOT_API_TOKEN;
const RECIFE_INBOX_ID = 7;

const STUCK_THRESHOLD_MIN = 30; // 30min sem clique = considerar stuck
const ALERT_THRESHOLD_COUNT = 3; // >=3 simultâneas = enviar alerta
const COOLDOWN_HOURS = 4; // anti-spam: re-alerta só após 4h

const EMAIL_FROM = process.env.EMAIL_FROM || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = (process.env.EMAIL_TO || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

const ALERT_BLOB_KEY = 'alerts/bot-stuck-last.json';

/**
 * GET conversations Inbox 7 status=open via Chatwoot API
 */
async function fetchOpenConversations() {
  const url = `${CW_URL}/api/v1/accounts/${CW_ACCOUNT}/conversations?inbox_id=${RECIFE_INBOX_ID}&status=open&per_page=100&sort=-last_activity_at`;
  const res = await fetch(url, { headers: { 'api_access_token': CW_TOKEN } });
  if (!res.ok) {
    throw new Error(`Chatwoot HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  return (data?.data?.payload || []);
}

/**
 * Classifica conversa: stuck (bot_active=true + > threshold min sem atividade)?
 */
function isStuck(conv, nowSec, thresholdSec) {
  const ca = conv.custom_attributes || {};
  if (ca.bot_active !== true) return false;
  const lastActivity = conv.last_activity_at || conv.created_at || 0;
  return (nowSec - lastActivity) >= thresholdSec;
}

/**
 * Anti-spam: ler última alert do Blob
 */
async function getLastAlert() {
  if (!BLOB_TOKEN) return null;
  try {
    const meta = await head(ALERT_BLOB_KEY, { token: BLOB_TOKEN });
    const res = await fetch(meta.url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function saveLastAlert(payload) {
  if (!BLOB_TOKEN) return;
  try {
    await put(ALERT_BLOB_KEY, JSON.stringify(payload), {
      access: 'public',
      token: BLOB_TOKEN,
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch (e) {
    console.error('[BOT-STUCK] failed to save alert blob:', e.message);
  }
}

/**
 * Email alert via nodemailer (mesma infra dos outros crons).
 */
let _transport = null;
function getTransport() {
  if (!_transport && EMAIL_PASS) {
    _transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_FROM, pass: EMAIL_PASS },
    });
  }
  return _transport;
}

async function sendAlertEmail(stuckList, totalOpen) {
  if (!EMAIL_PASS) {
    console.warn('[BOT-STUCK] EMAIL_PASS não configurado — email skipped');
    return;
  }
  const transport = getTransport();
  if (!transport) return;

  const subject = `[BOT-STUCK] ${stuckList.length} leads travados no Bot Welcome WA-RC (>${STUCK_THRESHOLD_MIN}min)`;

  const rows = stuckList.map(c => {
    const ca = c.custom_attributes || {};
    const sender = c.meta?.sender || {};
    const name = escapeHtml(sender.name || '?').slice(0, 30);
    const phone = escapeHtml(sender.phone_number || '?');
    const stepMin = Math.floor((Date.now()/1000 - (c.last_activity_at || c.created_at || 0)) / 60);
    return `<tr>
      <td>${c.id}</td>
      <td>${name}</td>
      <td>${phone}</td>
      <td>bot_step=${ca.bot_step || '?'}</td>
      <td>${stepMin}min</td>
    </tr>`;
  }).join('');

  const html = `
    <h2>🤖 Bot Welcome WA-RC — ${stuckList.length} leads travados</h2>
    <p><strong>Threshold:</strong> ${STUCK_THRESHOLD_MIN}min sem clique</p>
    <p><strong>Total conv open Inbox 7:</strong> ${totalOpen}</p>
    <p><strong>Detectado às:</strong> ${brtISO()} BRT</p>
    <h3>Leads travados:</h3>
    <table border="1" cellpadding="5" cellspacing="0">
      <tr><th>Conv</th><th>Nome</th><th>Phone</th><th>Estado</th><th>Tempo</th></tr>
      ${rows}
    </table>
    <p><em>Modo passivo: este monitor SÓ ALERTA. Bot não foi modificado. Atendente humano pode cobrir manualmente se necessário.</em></p>
    <p><em>Próximo alerta após ${COOLDOWN_HOURS}h cooldown ou aumento significativo.</em></p>
  `;

  await transport.sendMail({
    from: `"IceLaser Bot Monitor" <${EMAIL_FROM}>`,
    to: EMAIL_TO.join(','),
    subject: sanitizeHeader(subject),
    html,
  });
  console.log(`[BOT-STUCK] alert email enviado: ${stuckList.length} stuck`);
}

export default async function handler(req, res) {
  // Cron auth — só Vercel cron OU CRON_SECRET válido
  // FIX V4.1 (Codex): comentário falava "OU CRON_SECRET" mas só checava isVercelCron.
  // Agora dual auth: Vercel cron header OU Bearer manual test.
  const isBearerAuth = req.headers?.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!isVercelCron(req) && !isBearerAuth) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Multi-project guard: só roda no primary project (icelaser-landing)
  // FIX BUG 5 (Codex 17/05/2026): skipIfNotPrimary precisa de (res, cronName) — sem args
  // quebrava em projetos não-primary porque internamente faz res.status(200) — TypeError.
  if (skipIfNotPrimary(res, 'bot-stuck-check')) return;

  // FIX BUG 6: CHATWOOT_API_TOKEN agora é obrigatório (fallback hardcoded removido linha 36)
  if (!CW_TOKEN) {
    return res.status(500).json({ error: 'missing_env', detail: 'CHATWOOT_API_TOKEN not set' });
  }

  const startTs = Date.now();
  try {
    const conversations = await fetchOpenConversations();
    const nowSec = Math.floor(Date.now() / 1000);
    const thresholdSec = STUCK_THRESHOLD_MIN * 60;

    const stuck = conversations.filter(c => isStuck(c, nowSec, thresholdSec));
    const stuckCount = stuck.length;
    const totalOpen = conversations.length;

    // Sempre logar (data collection)
    const summary = {
      timestamp: brtISO(),
      total_open: totalOpen,
      stuck_count: stuckCount,
      stuck_pct: totalOpen ? (stuckCount / totalOpen * 100).toFixed(1) : 0,
      threshold_min: STUCK_THRESHOLD_MIN,
      stuck_conv_ids: stuck.map(c => c.id),
    };
    console.log(`[BOT-STUCK] ${JSON.stringify(summary)}`);

    // Anti-spam check + alerta se >= threshold count
    let alerted = false;
    if (stuckCount >= ALERT_THRESHOLD_COUNT) {
      const lastAlert = await getLastAlert();
      const cooldownExpired = !lastAlert
        || (Date.now() - (lastAlert.ts || 0)) >= COOLDOWN_HOURS * 3600 * 1000;
      const significantIncrease = lastAlert
        && stuckCount >= (lastAlert.count || 0) + 2;

      if (cooldownExpired || significantIncrease) {
        await sendAlertEmail(stuck, totalOpen);
        await saveLastAlert({ ts: Date.now(), count: stuckCount, conv_ids: stuck.map(c => c.id) });
        alerted = true;
      } else {
        console.log(`[BOT-STUCK] cooldown ativo (${COOLDOWN_HOURS}h) ou sem aumento — alert skipped`);
      }
    }

    const duration = Date.now() - startTs;
    return res.status(200).json({
      ok: true,
      ...summary,
      alerted,
      duration_ms: duration,
    });
  } catch (e) {
    console.error('[BOT-STUCK] error:', e.message);
    return res.status(500).json({ error: 'internal_error', message: e.message });
  }
}
