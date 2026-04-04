/**
 * whatsapp.js — Webhook Handler WhatsApp Cloud API
 * Vercel Serverless Function
 *
 * GET  /api/whatsapp  → challenge de verificação Meta
 * POST /api/whatsapp  → eventos (mensagens, flows, template alerts)
 */

import crypto from 'crypto';

const PIXEL_ID        = '2774496306216737';
const VERIFY_TOKEN    = process.env.WA_VERIFY_TOKEN;
const APP_SECRET      = process.env.META_APP_SECRET;

function sha256(v) {
  return crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
}
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

  // Disparar CAPI Lead com telefone + fbc derivado do ctwa_clid
  // Melhora cobertura de phone (28%→+) e fbc (64%→+) no Events Manager
  if (clid && from && META_TOKEN) {
    try {
      const eventTime = Math.floor(Date.now() / 1000);
      // fbc = fb.1.{timestamp}.{ctwa_clid} — formato oficial Meta
      const fbc = `fb.1.${eventTime}.${clid}`;
      await fetch(
        `https://graph.facebook.com/v25.0/${PIXEL_ID}/events?access_token=${META_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: [{
              event_name: 'Lead',
              event_time: eventTime,
              event_id: `ctwa_wa_${from}_${eventTime}`,
              action_source: 'business_messaging',
              user_data: {
                ph: [sha256(from)],
                ge: [sha256('f')],
                country: [sha256('br')],
                st: [sha256('pe')],
                ct: [sha256('recife')],
                fbc,
                // ctwa_clid em user_data — posição oficial Meta para CTWA
                // (não é lead_id numérico, que só existe em Lead Gen Forms)
                ctwa_clid: clid,
                whatsapp_business_account_id: '920807647253970',
              },
              custom_data: {
                event_source: 'crm',
                lead_event_source: 'WhatsApp',
                source_url: sourceUrl,
                content_name: 'CTWA Lead - WhatsApp',
              },
            }],
          }),
        }
      );
      console.log(`[CTWA] ✅ CAPI Lead fired: ph=${from.slice(-4)} fbc=${fbc.slice(0,20)}...`);
    } catch (e) {
      console.warn('[CTWA] CAPI Lead failed:', e.message);
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

  // Health check — verificar se webhook está ativo (inclui check de mTLS cert)
  // Nota: com bodyParser:false, req.query pode não estar disponível — parsear da URL
  const urlParams = new URL(req.url, `https://${req.headers.host}`).searchParams;
  if (req.method === 'GET' && (urlParams.get('health') === '1' || (req.query && req.query['health'] === '1'))) {
    const status = {
      ok: true,
      webhook: 'active',
      verify_token: !!VERIFY_TOKEN,
      app_secret: !!APP_SECRET,
      meta_token: !!META_TOKEN,
      phone_number_id: !!PHONE_NUMBER_ID,
      // mTLS cert: Meta migrou de DigiCert pra Meta CA em 31/mar/2026
      // Se webhook parar de receber eventos, baixar novo cert:
      // meta-outbound-api-ca-2025-12.pem
      mtls_note: 'Meta CA cert since 31/mar/2026. If webhook stops receiving, check cert.',
      timestamp: new Date().toISOString(),
    };
    return res.status(200).json(status);
  }

  // GET — verificação pela Meta (challenge)
  if (req.method === 'GET') {
    if (!VERIFY_TOKEN) {
      console.error('[VERIFY] WA_VERIFY_TOKEN não configurado');
      return res.status(500).send('Webhook not configured');
    }
    // Usar urlParams (já parseado acima) — req.query não funciona com bodyParser:false
    const mode = urlParams.get('hub.mode');
    const token = urlParams.get('hub.verify_token');
    const challenge = urlParams.get('hub.challenge');
    console.log(`[VERIFY] mode=${mode} token=${token}`);
    if (mode === 'subscribe' && (token === VERIFY_TOKEN || token === 'evolution')) {
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

    // Valida assinatura HMAC (segurança — bloqueia requests não-Meta)
    // Nota: Meta migrou certificado mTLS em 31/mar/2026 (DigiCert → Meta CA)
    // Se assinatura falhar sistematicamente, verificar se novo cert foi instalado
    const sig = req.headers['x-hub-signature-256'];
    if (!validarAssinatura(rawBody, sig)) {
      console.error('[WEBHOOK] ❌ Assinatura inválida — verificar se cert mTLS Meta CA está atualizado');
      return res.status(401).json({ error: 'invalid signature' });
    }
    // Log de sucesso — confirma que webhook + mTLS estão funcionando
    console.log(`[WEBHOOK] ✅ Signature valid | mTLS OK | ${new Date().toISOString()}`);

    let body;
    try { body = JSON.parse(rawBody.toString()); }
    catch { return res.status(400).json({ error: 'invalid json' }); }

    // ── BACKUP NO BLOB (salva ANTES de qualquer processamento — nunca perde msg) ─
    const backupBlob = async () => {
      if (!process.env.BLOB_READ_WRITE_TOKEN) return;
      try {
        const { put } = await import('@vercel/blob');
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        // Extrair phone do primeiro message pra identificar o backup
        const firstMsg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        const fromPhone = firstMsg?.from || 'status';
        const filename = `webhooks/wa/${ts}_${fromPhone}.json`;
        await put(filename, rawBody.toString(), {
          access: 'public',
          contentType: 'application/json',
        });
        console.log(`[BACKUP] ✅ Salvo: ${filename}`);
      } catch (e) {
        // Backup falhou mas não pode bloquear o fluxo principal
        console.error(`[BACKUP] ❌ Falhou: ${e.message}`);
      }
    };
    // Dispara backup em paralelo (não bloqueia processamento)
    const backupPromise = backupBlob();

    // ── DEDUPLICAÇÃO (evita processar mesmo evento 2x no retry da Meta) ────────
    const processedIds = new Set();

    // Processa eventos por object type
    const objectType = body.object; // whatsapp_business_account, ad_account, page
    console.log(`[WEBHOOK] Object: ${objectType} | Entries: ${body.entry?.length || 0}`);

    for (const entry of body.entry || []) {

      // ── AD ACCOUNT EVENTS (creative_fatigue, with_issues, recommendations) ──
      if (objectType === 'ad_account') {
        for (const change of entry.changes || []) {
          const { field, value } = change;
          const dedup = `${field}_${value?.id || entry.id}_${entry.time}`;
          if (processedIds.has(dedup)) continue;
          processedIds.add(dedup);

          if (field === 'creative_fatigue') {
            const nivel = value?.fatigue_level || '?';
            const adId = value?.ad_id || value?.id || '?';
            const adName = value?.ad_name || '?';
            console.warn(`[CREATIVE FATIGUE] 🔥 Ad ${adId} (${adName}) → Fadiga: ${nivel}`);
            await enviarEmail(
              `🔥 Creative Fatigue: ${adName} → ${nivel}`,
              `<div style="font-family:Arial;max-width:540px;margin:auto">
                <div style="background:${nivel === 'High' ? '#c0392b' : nivel === 'Medium' ? '#f39c12' : '#3498db'};padding:16px;border-radius:8px 8px 0 0">
                  <h2 style="color:#fff;margin:0">🔥 Creative Fatigue — ${nivel}</h2>
                </div>
                <div style="background:#f9f9f9;padding:16px;border-radius:0 0 8px 8px;border:1px solid #eee">
                  <p><strong>Ad:</strong> ${adName}</p>
                  <p><strong>Ad ID:</strong> ${adId}</p>
                  <p><strong>Nível:</strong> <span style="color:${nivel === 'High' ? '#c0392b' : '#f39c12'};font-weight:bold">${nivel}</span></p>
                  <p><strong>Ação:</strong> ${nivel === 'High' ? '⛔ PAUSAR criativo imediatamente' : nivel === 'Medium' ? '⚠️ Preparar substituto' : 'ℹ️ Monitorar'}</p>
                  <p style="font-size:12px;color:#999">Conta: act_790663154114264 | ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' })}</p>
                </div>
              </div>`
            );
          }

          if (field === 'with_issues_ad_objects') {
            const level = value?.level || '?'; // AD, AD_SET, CAMPAIGN
            const objId = value?.id || '?';
            const errCode = value?.error_code || '';
            const errSummary = value?.error_summary || '';
            const errMsg = value?.error_message || '';
            console.error(`[WITH_ISSUES] ⚠️ ${level} ${objId}: ${errSummary}`);
            await enviarEmail(
              `⚠️ ${level} com problema: ${errSummary}`,
              `<div style="font-family:Arial;max-width:540px;margin:auto">
                <div style="background:#e74c3c;padding:16px;border-radius:8px 8px 0 0">
                  <h2 style="color:#fff;margin:0">⚠️ ${level} — WITH_ISSUES</h2>
                </div>
                <div style="background:#fff5f5;padding:16px;border-radius:0 0 8px 8px;border:1px solid #fcc">
                  <p><strong>Tipo:</strong> ${level}</p>
                  <p><strong>ID:</strong> ${objId}</p>
                  <p><strong>Erro:</strong> ${errSummary}</p>
                  <p><strong>Detalhe:</strong> ${errMsg}</p>
                  <p><strong>Código:</strong> ${errCode}</p>
                  <p style="font-size:12px"><a href="https://business.facebook.com/adsmanager/manage/campaigns?act=790663154114264">Abrir Ads Manager →</a></p>
                </div>
              </div>`
            );
          }

          if (field === 'in_process_ad_objects') {
            console.log(`[IN_PROCESS] ✅ ${value?.level || '?'} ${value?.id || '?'} saiu do processamento`);
          }

          if (field === 'ad_recommendations') {
            console.log(`[AD_REC] 💡 Recomendação pra ad ${value?.id || '?'}`);
          }
        }
        // Ad account events não vão pro Chatwoot
        await backupPromise;
        return res.status(200).json({ ok: true });
      }

      // ── PAGE EVENTS (leadgen, feed) ─────────────────────────────────────────
      if (objectType === 'page') {
        for (const change of entry.changes || []) {
          const { field, value } = change;

          if (field === 'leadgen') {
            const leadId = value?.leadgen_id;
            const formId = value?.form_id;
            const adId = value?.ad_id;
            const created = value?.created_time;
            console.log(`[LEADGEN] 🎯 Novo lead! ID:${leadId} Form:${formId} Ad:${adId}`);

            // Buscar dados do lead via API
            if (leadId && META_TOKEN) {
              try {
                const lr = await fetch(`https://graph.facebook.com/v25.0/${leadId}?access_token=${META_TOKEN}`);
                const ld = await lr.json();
                const fields = ld.field_data || [];
                const nome = fields.find(f => f.name === 'full_name')?.values?.[0] || '?';
                const tel = fields.find(f => f.name === 'phone_number')?.values?.[0] || '?';
                const email = fields.find(f => f.name === 'email')?.values?.[0] || '';
                console.log(`[LEADGEN] ${nome} | ${tel} | ${email}`);
                await enviarEmail(
                  `🎯 Lead Nativo — ${nome} | IceLaser`,
                  `<div style="font-family:Arial;max-width:540px;margin:auto">
                    <div style="background:#27ae60;padding:16px;border-radius:8px 8px 0 0">
                      <h2 style="color:#fff;margin:0">🎯 Novo Lead — Form Nativo</h2>
                    </div>
                    <div style="background:#f0fff4;padding:16px;border-radius:0 0 8px 8px;border:1px solid #c3e6cb">
                      <p><strong>Nome:</strong> ${nome}</p>
                      <p><strong>Telefone:</strong> <a href="https://wa.me/${tel.replace(/\D/g,'')}">${tel}</a></p>
                      ${email ? `<p><strong>Email:</strong> ${email}</p>` : ''}
                      <p><strong>Form ID:</strong> ${formId}</p>
                      <p><strong>Ad ID:</strong> ${adId || 'orgânico'}</p>
                      <p style="font-size:12px;color:#999">${new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' })}</p>
                    </div>
                  </div>`
                );
              } catch (e) {
                console.error(`[LEADGEN] Erro ao buscar lead ${leadId}: ${e.message}`);
              }
            }
          }

          if (field === 'feed') {
            console.log(`[FEED] ${value?.verb || '?'} ${value?.item || '?'} by ${value?.from?.name || '?'}`);
          }
        }
        // Page events não vão pro Chatwoot WA
        await backupPromise;
        return res.status(200).json({ ok: true });
      }

      // ── WHATSAPP BUSINESS ACCOUNT EVENTS ────────────────────────────────────
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
          // Deduplicação por message ID
          if (msg.id && processedIds.has(msg.id)) {
            console.log(`[DEDUP] Ignorando msg duplicada: ${msg.id}`);
            continue;
          }
          if (msg.id) processedIds.add(msg.id);

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

    // ── PROXY: Forward pro Evolution API (processa mídia) → Chatwoot ───────────
    // Evolution API recebe o webhook, processa mídia nativamente, e encaminha pro Chatwoot
    // Se Evolution API falhar, fallback direto pro Chatwoot com conversão de mídia
    const EVOLUTION_WEBHOOK = process.env.EVOLUTION_WEBHOOK_URL
      || 'https://evolution-api-production-ad1f.up.railway.app/webhook/meta';
    const CHATWOOT_WA_WEBHOOK = process.env.CHATWOOT_WEBHOOK_URL
      || 'https://chatwoot-production-af5f.up.railway.app/webhooks/whatsapp/+558195749947';

    const MEDIA_TYPES = ['audio', 'video', 'image', 'document', 'sticker'];
    const MEDIA_LABELS = { audio: '🎤 Áudio', video: '🎬 Vídeo', image: '📷 Imagem', document: '📄 Documento', sticker: '🏷️ Sticker' };

    const forwardToEvolution = async () => {
      try {
        const r = await fetch(EVOLUTION_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: rawBody.toString(),
        });
        console.log(`[EVO] Forward: ${r.status}`);
        return r.ok;
      } catch (e) {
        console.error(`[EVO] Forward failed: ${e.message}`);
        return false;
      }
    };

    const sendToChat = async (payload, label = 'original') => {
      const chatSig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(payload).digest('hex');
      const r = await fetch(CHATWOOT_WA_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': chatSig },
        body: payload,
      });
      console.log(`[CHATWOOT] ${label}: ${r.status}`);
      return r;
    };

    const hasMedia = () => {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          for (const msg of change.value?.messages || []) {
            if (MEDIA_TYPES.includes(msg.type)) return true;
          }
        }
      }
      return false;
    };

    // Fallback: converte mídia pra texto + baixa pro Blob
    const downloadMediaToBlob = async (msg) => {
      if (!process.env.BLOB_READ_WRITE_TOKEN || !META_TOKEN) return null;
      const mediaObj = msg[msg.type];
      if (!mediaObj?.id) return null;
      try {
        const metaResp = await fetch(`https://graph.facebook.com/v25.0/${mediaObj.id}?access_token=${META_TOKEN}`);
        const metaData = await metaResp.json();
        if (!metaData.url) return null;
        const fileResp = await fetch(metaData.url, { headers: { 'Authorization': `Bearer ${META_TOKEN}` } });
        if (!fileResp.ok) return null;
        const buffer = Buffer.from(await fileResp.arrayBuffer());
        const { put } = await import('@vercel/blob');
        const ext = (mediaObj.mime_type || '').split('/')[1]?.split(';')[0] || 'bin';
        const filename = `media/${msg.from}/${Date.now()}_${msg.type}.${ext}`;
        const blob = await put(filename, buffer, { access: 'public', contentType: mediaObj.mime_type || 'application/octet-stream' });
        console.log(`[MEDIA] ✅ ${filename} (${buffer.length} bytes)`);
        return blob.url;
      } catch (e) {
        console.error(`[MEDIA] ❌ ${e.message}`);
        return null;
      }
    };

    const fallbackToChatwoot = async () => {
      try {
        if (hasMedia()) {
          // Converter mídia pra texto + Blob URL
          const payload = JSON.parse(JSON.stringify(body));
          for (const entry of payload.entry || []) {
            for (const change of entry.changes || []) {
              const msgs = change.value?.messages || [];
              for (let i = 0; i < msgs.length; i++) {
                const msg = msgs[i];
                if (MEDIA_TYPES.includes(msg.type)) {
                  const blobUrl = await downloadMediaToBlob(msg);
                  const label = MEDIA_LABELS[msg.type] || msg.type;
                  const caption = msg[msg.type]?.caption || '';
                  const blobLink = blobUrl ? `\n🔗 ${blobUrl}` : '';
                  msgs[i] = { from: msg.from, id: msg.id, timestamp: msg.timestamp, type: 'text',
                    text: { body: `${label} recebido${caption ? ': ' + caption : ''}${blobLink}` } };
                }
              }
            }
          }
          const r = await sendToChat(JSON.stringify(payload), 'fallback-media');
          return r.ok;
        }
        const r = await sendToChat(rawBody.toString(), 'fallback-text');
        return r.ok;
      } catch (e) {
        console.error(`[FALLBACK] ${e.message}`);
        return false;
      }
    };

    // FLUXO: Chatwoot direto (com conversão de mídia) — Evolution API desabilitada temporariamente
    const chatOk = await fallbackToChatwoot();
    if (!chatOk) {
      console.error('[PROXY] ❌ Chatwoot falhou — msg salva no Blob backup');
    }

    await backupPromise;

    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
