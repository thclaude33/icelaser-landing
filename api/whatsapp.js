/**
 * whatsapp.js — Webhook Handler WhatsApp Cloud API
 * Vercel Serverless Function
 *
 * GET  /api/whatsapp  → challenge de verificação Meta
 * POST /api/whatsapp  → eventos (mensagens, flows, template alerts)
 */

import crypto from 'crypto';

const VERIFY_TOKEN    = process.env.WA_VERIFY_TOKEN;
const APP_SECRET      = process.env.META_APP_SECRET;
const EMAIL_FROM      = process.env.EMAIL_FROM  || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS      = process.env.EMAIL_PASS;
const EMAIL_TO        = (process.env.EMAIL_TO   || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');
const META_TOKEN      = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;

// ── CORPO RAW (necessário para validar assinatura HMAC) ───────────────────────
export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── VALIDAÇÃO HMAC ────────────────────────────────────────────────────────────
function validarAssinatura(rawBody, sig) {
  if (!APP_SECRET || !sig) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch { return false; }
}

// ── EMAIL via SMTP nativo (sem lib externa) ───────────────────────────────────
async function enviarEmail(assunto, html) {
  if (!EMAIL_PASS) { console.warn('[EMAIL] EMAIL_PASS não configurado — email ignorado'); return false; }
  try {
    const nodemailer = (await import('nodemailer')).default;
    const t = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_FROM, pass: EMAIL_PASS },
    });
    await t.sendMail({ from: `"IceLaser Bot" <${EMAIL_FROM}>`, to: EMAIL_TO.join(','), subject: assunto, html });
    return true;
  } catch (e) {
    console.error('[EMAIL]', e.message);
    return false;
  }
}

// ── PROCESSA LEAD VIA FLOW ────────────────────────────────────────────────────
async function processarLeadFlow(from, nfmReply, ctwaClid) {
  let dados = {};
  try { dados = JSON.parse(nfmReply.response_json || '{}'); } catch {}

  const nome     = dados.nome || dados.full_name || dados.name || from;
  const telefone = dados.telefone || dados.phone || from;
  const servico  = dados.servico || dados.service || 'Depilação Laser';
  const agora    = new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' });

  console.log(`[LEAD FLOW] ${nome} | ${telefone} | ${servico} | ctwa:${ctwaClid || 'direto'}`);

  const ctwaTag = ctwaClid
    ? `<span style="background:#1877f2;color:#fff;font-size:11px;padding:2px 8px;border-radius:4px">📣 CTWA</span>`
    : `<span style="background:#25D366;color:#fff;font-size:11px;padding:2px 8px;border-radius:4px">📲 Direto</span>`;

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:580px;margin:auto">
    <div style="background:#1a1a2e;padding:20px;border-radius:8px 8px 0 0">
      <h2 style="color:#fff;margin:0">🚀 Novo Lead — WhatsApp Flow</h2>
      <p style="color:#aaa;margin:5px 0 0">${agora}</p>
    </div>
    <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:8px 0;color:#666;width:100px">Nome</td>
            <td style="padding:8px 0"><strong>${nome}</strong></td></tr>
        <tr><td style="padding:8px 0;color:#666">Telefone</td>
            <td style="padding:8px 0">
              <a href="https://wa.me/55${telefone.replace(/\D/g,'')}" style="color:#25D366;font-weight:bold">${telefone}</a>
            </td></tr>
        <tr><td style="padding:8px 0;color:#666">Serviço</td>
            <td style="padding:8px 0">${servico}</td></tr>
        <tr><td style="padding:8px 0;color:#666">Origem</td>
            <td style="padding:8px 0">${ctwaTag}</td></tr>
        ${ctwaClid ? `<tr><td style="padding:8px 0;color:#666;font-size:11px">CTWA ID</td>
            <td style="padding:8px 0;font-size:11px;color:#999">${ctwaClid}</td></tr>` : ''}
      </table>
    </div>
  </div>`;

  await enviarEmail(`🔥 Lead Flow WA — ${nome} | IceLaser`, html);

  // Envia template de confirmação se Cloud API ativo
  if (META_TOKEN && from !== '—') {
    enviarTemplateConfirmacao(from, nome, servico).catch(e => console.error('[TEMPLATE]', e.message));
  }
}

// ── PROCESSA MENSAGEM CTWA + SALVA NO BLOB ───────────────────────────────────
async function processarCTWA(from, message, referral) {
  const clid = referral?.ctwa_clid;
  const sourceUrl = referral?.source_url || '';
  const sourceType = referral?.source_type || '';
  const headlineText = referral?.headline || '';
  const bodyText = referral?.body || '';
  console.log(`[CTWA] from=${from} clid=${clid} source=${sourceType} url=${sourceUrl}`);

  // Salvar ctwa_clid no Blob vinculado ao telefone — será recuperado pelo crm-webhook
  if (clid && from && process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { put } = await import('@vercel/blob');
      const ts = new Date().toISOString();
      await put(`ctwa/${from}.json`, JSON.stringify({
        ctwa_clid: clid,
        phone: from,
        source_url: sourceUrl,
        source_type: sourceType,
        headline: headlineText,
        body: bodyText,
        timestamp: ts,
      }), { access: 'public', contentType: 'application/json' });
      console.log(`[CTWA] Saved to Blob: ctwa/${from}.json`);
    } catch (e) {
      console.warn('[CTWA] Blob save failed:', e.message);
    }
  }

  return clid;
}

// ── PROCESSA ALERTA DE TEMPLATE ───────────────────────────────────────────────
async function processarAlertaTemplate(ev) {
  const nome   = ev.message_template_name || '?';
  const status = ev.event || '?';
  const agora  = new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' });
  console.warn(`[TEMPLATE ALERTA] ${nome} → ${status}`);

  if (['PAUSED','DISABLED','FLAGGED','REJECTED'].includes(status)) {
    const html = `
    <div style="font-family:Arial;max-width:540px;margin:auto">
      <div style="background:#c0392b;padding:16px;border-radius:8px 8px 0 0">
        <h2 style="color:#fff;margin:0">⚠️ Template WhatsApp Pausado</h2>
        <p style="color:#fcc;margin:4px 0 0">${agora}</p>
      </div>
      <div style="background:#fff5f5;padding:16px;border-radius:0 0 8px 8px;border:1px solid #fcc">
        <p><strong>Template:</strong> ${nome}</p>
        <p><strong>Status:</strong> <span style="color:#c0392b">${status}</span></p>
        <p style="font-size:12px"><a href="https://business.facebook.com/wa/manage/message-templates/">
          Abrir WhatsApp Manager →</a></p>
      </div>
    </div>`;
    await enviarEmail(`⚠️ Template WA pausado: ${nome}`, html);
  }
}

// ── ENVIA TEMPLATE DE CONFIRMAÇÃO ─────────────────────────────────────────────
async function enviarTemplateConfirmacao(to, nome, servico) {
  const r = await fetch(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${META_TOKEN}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: 'confirmacao_lead_icelaser',
        language: { code: 'pt_BR' },
        components: [{ type: 'body', parameters: [
          { type: 'text', text: nome.split(' ')[0] },
          { type: 'text', text: servico },
        ]}],
      },
    }),
  });
  const d = await r.json();
  if (d.error) console.error('[TEMPLATE SEND]', d.error.message);
  else console.log('[TEMPLATE SENT]', d.messages?.[0]?.id);
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────────
export default async function handler(req, res) {

  // GET — verificação pela Meta (challenge)
  if (req.method === 'GET') {
    if (!VERIFY_TOKEN) {
      console.error('[VERIFY] WA_VERIFY_TOKEN não configurado');
      return res.status(500).send('Webhook not configured');
    }
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    console.log(`[VERIFY] mode=${mode} token=${token}`);
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('[VERIFY] ✅ OK');
      return res.status(200).send(challenge);
    }
    console.warn('[VERIFY] ❌ Token inválido');
    return res.status(403).send('Forbidden');
  }

  // POST — eventos reais
  if (req.method === 'POST') {
    if (!APP_SECRET) {
      console.error('[WEBHOOK] META_APP_SECRET não configurado — rejeitando todos os eventos');
      return res.status(500).json({ error: 'Webhook not configured' });
    }
    const rawBody = await getRawBody(req);

    // Valida assinatura (segurança — bloqueia requests não-Meta)
    const sig = req.headers['x-hub-signature-256'];
    if (!validarAssinatura(rawBody, sig)) {
      console.error('[WEBHOOK] Assinatura inválida');
      return res.status(401).json({ error: 'invalid signature' });
    }

    let body;
    try { body = JSON.parse(rawBody.toString()); }
    catch { return res.status(400).json({ error: 'invalid json' }); }

    // Processa eventos
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const { field, value } = change;

        // Template status update
        if (field === 'message_template_status_update') {
          await processarAlertaTemplate(value);
          continue;
        }

        if (field !== 'messages') continue;

        // Mensagens
        for (const msg of value.messages || []) {
          const from = msg.from;
          let ctwaClid = null;

          // CTWA — veio de anúncio
          if (msg.referral?.ctwa_clid) {
            ctwaClid = await processarCTWA(from, msg, msg.referral);
          }

          // Lead via Flow (nfm_reply)
          if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
            await processarLeadFlow(from, msg.interactive.nfm_reply, ctwaClid);
            continue;
          }

          // Texto normal
          if (msg.type === 'text') {
            console.log(`[MSG] ${from}: ${(msg.text?.body || '').substring(0, 80)}`);
          }
        }

        // Status de mensagens enviadas
        for (const st of value.statuses || []) {
          if (st.status === 'failed') {
            console.error(`[MSG FAILED] id=${st.id} | ${st.errors?.[0]?.title}`);
          }
        }
      }
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
