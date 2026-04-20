/**
 * whatsapp.js — Webhook Handler WhatsApp Cloud API
 * Vercel Serverless Function
 *
 * GET  /api/whatsapp  → challenge de verificação Meta
 * POST /api/whatsapp  → eventos (mensagens, flows, template alerts)
 */

import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { put, head } from '@vercel/blob';
import { PIXEL_ID, GRAPH_BASE } from './_lib/config.js';
import { sha256, timingSafeStringEqual, maskPhone, maskEmail, maskName, escapeHtml, sanitizeHeader } from './_lib/security.js';
import { buildUserData } from './_lib/piiBuilder.js';
import { PARTNER_AGENT } from './_lib/capi.js';

const VERIFY_TOKEN    = process.env.WA_VERIFY_TOKEN;
const APP_SECRET      = process.env.META_APP_SECRET;
const EMAIL_FROM      = process.env.EMAIL_FROM  || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS      = process.env.EMAIL_PASS;
const EMAIL_TO        = (process.env.EMAIL_TO   || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');
const META_TOKEN      = process.env.META_ACCESS_TOKEN;       // broad scope — Graph API lookups (ad_id, profile_name, message media)
const CAPI_TOKEN      = process.env.CAPI_DATASET_TOKEN || META_TOKEN;  // dataset-scoped — POST /events CAPI (LeadSubmitted)
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
    const t = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_FROM, pass: EMAIL_PASS },
    });
    // sanitizeHeader defense-in-depth: subject nunca deve ter CRLF (SMTP injection).
    await t.sendMail({
      from: `"IceLaser Bot" <${EMAIL_FROM}>`,
      to: EMAIL_TO.join(','),
      subject: sanitizeHeader(assunto, 200),
      html,
    });
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

  console.log(`[LEAD FLOW] ${maskName(nome)} | ${maskPhone(telefone)} | ${servico} | ctwa:${ctwaClid ? ctwaClid.slice(0,12)+'...' : 'direto'}`);

  const ctwaTag = ctwaClid
    ? `<span style="background:#1877f2;color:#fff;font-size:11px;padding:2px 8px;border-radius:4px">📣 CTWA</span>`
    : `<span style="background:#25D366;color:#fff;font-size:11px;padding:2px 8px;border-radius:4px">📲 Direto</span>`;

  // XSS-safe: user-controlled fields (nome, telefone, servico) passam por escapeHtml.
  const nomeSafe = escapeHtml(nome);
  const telefoneSafe = escapeHtml(telefone);
  const servicoSafe = escapeHtml(servico);
  const ctwaClidSafe = escapeHtml(ctwaClid || '');
  const telDigits = String(telefone || '').replace(/\D/g, '');
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:580px;margin:auto">
    <div style="background:#1a1a2e;padding:20px;border-radius:8px 8px 0 0">
      <h2 style="color:#fff;margin:0">🚀 Novo Lead — WhatsApp Flow</h2>
      <p style="color:#aaa;margin:5px 0 0">${agora}</p>
    </div>
    <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:8px 0;color:#666;width:100px">Nome</td>
            <td style="padding:8px 0"><strong>${nomeSafe}</strong></td></tr>
        <tr><td style="padding:8px 0;color:#666">Telefone</td>
            <td style="padding:8px 0">
              <a href="https://wa.me/55${telDigits}" style="color:#25D366;font-weight:bold">${telefoneSafe}</a>
            </td></tr>
        <tr><td style="padding:8px 0;color:#666">Serviço</td>
            <td style="padding:8px 0">${servicoSafe}</td></tr>
        <tr><td style="padding:8px 0;color:#666">Origem</td>
            <td style="padding:8px 0">${ctwaTag}</td></tr>
        ${ctwaClid ? `<tr><td style="padding:8px 0;color:#666;font-size:11px">CTWA ID</td>
            <td style="padding:8px 0;font-size:11px;color:#999">${ctwaClidSafe}</td></tr>` : ''}
      </table>
    </div>
  </div>`;

  await enviarEmail(`🔥 Lead Flow WA — ${String(nome).replace(/[\r\n]/g, ' ').slice(0, 100)} | IceLaser`, html);

  // Envia template de confirmação se Cloud API ativo
  if (META_TOKEN && from !== '—') {
    enviarTemplateConfirmacao(from, nome, servico).catch(e => console.error('[TEMPLATE]', e.message));
  }
}

/**
 * Lookup Meta Graph API pra obter campaign_id/adset_id/ad_name a partir do ad_id.
 * ad_id vem em referral.source_id quando usuário clica em CTWA ad.
 * Retorna { campaign_id, adset_id, ad_name, name } ou null.
 *
 * Uma chamada extra (~200ms) mas enriquece o CAPI LeadSubmitted com full
 * attribution — útil em campanhas Advantage+ onde Meta Ads Manager UTM
 * tags não propagam pro WhatsApp link.
 */
async function lookupAdMetadata(adId) {
  if (!adId || !META_TOKEN) return null;
  try {
    // Expandido pra trazer TODO o útil pra attribution CTWA:
    // - campaign_id/name (já tínhamos)
    // - adset_id/name (já tínhamos)
    // - objective: MESSAGES (CTWA padrão) vs OUTCOME_SALES vs OUTCOME_ENGAGEMENT
    // - destination_type: WHATSAPP (MESSAGES adset) ou ON_AD/APP_STORE/etc
    // - optimization_goal: CONVERSATIONS, LEAD_GENERATION, CONVERSIONS, etc
    // - placement: feed/stories/reels (via adset.targeting.publisher_platforms)
    // Meta rate-limit: 1 call extra por novo CTWA lead. Com cache Blob futuro
    // (por ad_id vs por phone atual), pode reduzir em >95%.
    const adFields = 'name,adset_id,adset_name,campaign_id,campaign_name';
    const adsetFields = 'optimization_goal,destination_type,targeting';
    const campaignFields = 'objective,buying_type,status';
    const fields = `${adFields},adset{${adsetFields}},campaign{${campaignFields}}`;
    const r = await fetch(`${GRAPH_BASE}/${adId}?fields=${fields}`, {
      headers: { 'Authorization': `Bearer ${META_TOKEN}` },
    });
    const data = await r.json();
    if (data.error) {
      console.warn(`[CTWA AD-LOOKUP] ${adId}: ${data.error.message}`);
      return null;
    }
    const pubPlatforms = data.adset?.targeting?.publisher_platforms;
    return {
      ad_id: adId,
      ad_name: data.name || null,
      adset_id: data.adset_id || null,
      adset_name: data.adset_name || null,
      campaign_id: data.campaign_id || null,
      campaign_name: data.campaign_name || null,
      // Novos campos ricos:
      optimization_goal: data.adset?.optimization_goal || null,   // ex: CONVERSATIONS
      destination_type: data.adset?.destination_type || null,     // ex: WHATSAPP
      publisher_platforms: Array.isArray(pubPlatforms) ? pubPlatforms.join(',') : null, // "facebook,instagram"
      campaign_objective: data.campaign?.objective || null,       // ex: OUTCOME_ENGAGEMENT
      buying_type: data.campaign?.buying_type || null,            // AUCTION / RESERVED
    };
  } catch (e) {
    console.warn(`[CTWA AD-LOOKUP] exception: ${e.message}`);
    return null;
  }
}

/**
 * Mapeia DDD brasileiro pro estado. Meta CAPI user_data.st espera 2-letter
 * lowercase. Hardcoded 'pe' era incorrecto pra leads de outros DDDs.
 * Fontes: ANATEL + JARVIS ref.
 */
const DDD_TO_STATE = {
  11:'sp',12:'sp',13:'sp',14:'sp',15:'sp',16:'sp',17:'sp',18:'sp',19:'sp',
  21:'rj',22:'rj',24:'rj',
  27:'es',28:'es',
  31:'mg',32:'mg',33:'mg',34:'mg',35:'mg',37:'mg',38:'mg',
  41:'pr',42:'pr',43:'pr',44:'pr',45:'pr',46:'pr',
  47:'sc',48:'sc',49:'sc',
  51:'rs',53:'rs',54:'rs',55:'rs',
  61:'df',
  62:'go',64:'go',
  63:'to',
  65:'mt',66:'mt',
  67:'ms',
  68:'ac',
  69:'ro',
  71:'ba',73:'ba',74:'ba',75:'ba',77:'ba',
  79:'se',
  81:'pe',87:'pe',
  82:'al',
  83:'pb',
  84:'rn',
  85:'ce',88:'ce',
  86:'pi',89:'pi',
  91:'pa',93:'pa',94:'pa',
  92:'am',97:'am',
  95:'rr',
  96:'ap',
  98:'ma',99:'ma',
};
function stateFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  // E.164 BR: 55 + DDD (2) + número
  if (digits.length >= 12 && digits.slice(0, 2) === '55') {
    const ddd = parseInt(digits.slice(2, 4), 10);
    if (DDD_TO_STATE[ddd]) return DDD_TO_STATE[ddd];
  }
  return 'pe'; // fallback Recife
}

// ── PROCESSA MENSAGEM CTWA + SALVA NO BLOB ───────────────────────────────────
async function processarCTWA(from, message, referral, profileName) {
  const clid = referral?.ctwa_clid;
  const sourceUrl = referral?.source_url || '';
  const sourceType = referral?.source_type || '';
  const sourceId = referral?.source_id || '';
  const headlineText = referral?.headline || '';
  const bodyText = referral?.body || '';
  const mediaType = referral?.media_type || '';
  const imageUrl = referral?.image_url || '';
  const videoUrl = referral?.video_url || '';
  const thumbnailUrl = referral?.thumbnail_url || '';
  // Campos extras NÃO-oficiais Meta Cloud API mas presentes em alguns providers
  // (Evolution, Baileys, contextInfo.externalAdReply) — capturar quando chegarem:
  const refCustom = referral?.ref || '';                // custom string do botão do ad
  const sourceApp = referral?.source_app || '';          // "facebook" ou "instagram"
  const adType = referral?.ad_type || '';                // "CTWA" ou "CAWC"
  const welcomeMsgText = referral?.welcome_message?.text ||
                         referral?.greeting_message_body || '';
  const isCall = !!referral?.click_to_whatsapp_call;

  // Lookup Meta Graph API pra enriquecer com metadata da campanha/adset/ad.
  // Paralelo com Blob save pra não atrasar o handler.
  const adMetadataPromise = lookupAdMetadata(sourceId);

  console.log(`[CTWA] from=${maskPhone(from)} profile=${profileName ? maskName(profileName) : '?'} clid=${(clid||'').slice(0,12)}... source_id=${sourceId} type=${sourceType}`);

  // Primeira msg do user (se texto) — intent signal útil pra segmentação.
  const firstMsgType = message?.type || '';
  const firstMsgText = (message?.type === 'text' ? message.text?.body : '') || '';

  // Salvar ctwa_clid + enriched data no Blob — será recuperado pelo crm-webhook
  // pra enriquecer Lead Quente / Purchase eventos com advanced matching.
  const adMetadata = await adMetadataPromise;
  if (clid && from && process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const ts = new Date().toISOString();
      const safeFrom = String(from).replace(/[^0-9]/g, '').slice(0, 20);
      if (!safeFrom) throw new Error('invalid phone');
      await put(`ctwa/${safeFrom}.json`, JSON.stringify({
        ctwa_clid: clid,
        phone: safeFrom,
        profile_name: profileName || null,
        state: stateFromPhone(safeFrom),  // inferido do DDD brasileiro
        source_url: sourceUrl,
        source_type: sourceType,
        source_id: sourceId,
        headline: headlineText,
        body: bodyText,
        media_type: mediaType,
        image_url: imageUrl,
        video_url: videoUrl,
        thumbnail_url: thumbnailUrl,
        // Campos não-Meta-oficial mas úteis quando presentes:
        ref_custom: refCustom || null,              // "landing_page_01", "patch_video_ad", etc
        source_app: sourceApp || null,              // "facebook" | "instagram"
        ad_type: adType || null,                    // "CTWA" | "CAWC"
        welcome_message: welcomeMsgText || null,    // texto auto-greeting configurado
        click_to_whatsapp_call: isCall,             // CTWA Call ad (vs chat)
        first_msg_type: firstMsgType,
        first_msg_text: firstMsgText.slice(0, 500),
        ad_metadata: adMetadata,
        timestamp: ts,
      }), { access: 'public', contentType: 'application/json', allowOverwrite: true });
      console.log(`[CTWA] Saved to Blob: ctwa/${safeFrom}.json (profile=${!!profileName}, ad_meta=${!!adMetadata})`);
    } catch (e) {
      console.warn('[CTWA] Blob save failed:', e.message);
    }
  }

  // Disparar CAPI LeadSubmitted (ContactStarted) com telefone + fbc derivado do ctwa_clid
  // Meta oficial (2026): business_messaging aceita 14 eventos; "Lead" NÃO está — "LeadSubmitted" é o correto.
  // Também OBRIGATÓRIO: messaging_channel = "whatsapp" (sem ele, erro 2804063).
  // Este evento representa o 1º contato do lead via CTWA ad — atribuição do click.
  // (Lead qualificado real é disparado depois pelo crm-webhook via label lead_quente.)
  if (clid && from && META_TOKEN) {
    try {
      // event_time: prefere timestamp do WA webhook (message.timestamp, unix seconds).
      // Se Meta retentar o webhook, event_time ainda é consistente com 1ª entrega.
      const msgTs = parseInt(message?.timestamp, 10);
      const eventTime = Number.isFinite(msgTs) && msgTs > 0
        ? msgTs
        : Math.floor(Date.now() / 1000);
      // event_id ESTÁVEL: Meta retenta webhook por 7 dias. Se cada retry gerar
      // event_id diferente (com Date.now()), CAPI dedup não funciona → evento
      // contado múltiplas vezes. Usa message.id (wamid.XXX, único por msg) ou
      // fallback ctwa_clid (único por click) pra garantir estabilidade.
      const stableSeed = message?.id || clid;
      const eventId = `ctwa_${stableSeed}`;
      // fbc = fb.{subdomainIndex}.{creationTime_ms}.{ctwa_clid}
      // Meta SDK oficial: icelasers.com.br → subdomainIndex=2 (TLD composto .com.br).
      // Verificado rodando ParamBuilder nodejs v1.2.1 contra o host real.
      // creationTime_ms usa msgTs*1000 quando disponível (retry = mesmo fbc).
      const fbcTsMs = Number.isFinite(msgTs) && msgTs > 0 ? msgTs * 1000 : Date.now();
      const fbc = `fb.2.${fbcTsMs}.${clid}`;
      // user_data via SDK oficial Meta: normaliza + hasheia SHA-256 + deriva
      // partial matching keys (f5first, f5last, fi) automaticamente.
      // profile_name (do WhatsApp contact) vira first_name/last_name.
      // CRÍTICO pra EMQ: sem profile_name, LeadSubmitted CTWA só tinha ph+geo
      // como matching → EMQ ~4-5. Com fn/ln + f5first/fi → EMQ 6-7.
      let firstName = null, lastName = null;
      if (profileName) {
        const parts = profileName.trim().split(/\s+/);
        firstName = parts[0];
        if (parts.length > 1) lastName = parts[parts.length - 1];
      }
      const inferredState = stateFromPhone(from);
      const userData = await buildUserData({
        phone: from,
        first_name: firstName || undefined,
        last_name: lastName || undefined,
        gender: 'f',
        city: 'recife',
        state: inferredState,         // inferido pelo DDD (antes hardcoded 'pe')
        country: 'br',
        external_id: from,            // phone como identidade estável do lead
      });
      userData.fbc = fbc;
      userData.ctwa_clid = clid;
      // whatsapp_business_account_id REMOVIDO — Meta API v25 rejeita este campo
      // em user_data com `OAuthException code=1 "An unknown error has occurred"`
      // quando presente junto com ctwa_clid. Descoberto via reprodução direta
      // Graph API (4 testes isolados) em 18/04/2026. Mesma fix aplicado em
      // crm-webhook.js. Ver: feedback_meta_capi_waba_id_rejected.md
      // page_id: Meta Java SDK oficial lista como user_data key válida.
      // Para CTWA ads, page_id é o Facebook Page que hospeda o ad → melhora
      // attribution cross-device.
      if (process.env.META_PAGE_ID) userData.page_id = process.env.META_PAGE_ID;
      const r = await fetch(
        `${GRAPH_BASE}/${PIXEL_ID}/events`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CAPI_TOKEN}`,   // dataset-scoped — só POST events
          },
          body: JSON.stringify({
            data: [{
              // Oficial Meta 2026: Lista eventos válidos pra business_messaging (14):
              // Purchase, LeadSubmitted, InitiateCheckout, AddToCart, ViewContent,
              // OrderCreated/Shipped/Delivered/Canceled/Returned, CartAbandoned,
              // QualifiedLead, RatingProvided, ReviewProvided.
              // "Lead" NÃO está — gerava rejeição silenciosa antes.
              event_name: 'LeadSubmitted',
              event_time: eventTime,
              event_id: eventId,
              action_source: 'business_messaging',
              // OBRIGATÓRIO em business_messaging. Sem isto, Meta retorna 2804063.
              messaging_channel: 'whatsapp',
              user_data: userData,
              custom_data: {
                lead_event_source: 'WhatsApp CTWA',
                source_url: sourceUrl,
                content_name: 'CTWA Contact Started - WhatsApp',
                content_category: 'depilacao_laser',
                customer_segmentation: 'new_customer_to_business',
                // Enriquecimento: ad metadata do Meta Graph API lookup (source_id → adset/campaign).
                // Meta Andromeda 2026 usa esses IDs pra attribution cross-device.
                ...(adMetadata?.ad_id ? { ad_id: adMetadata.ad_id } : {}),
                ...(adMetadata?.ad_name ? { ad_name: adMetadata.ad_name } : {}),
                ...(adMetadata?.adset_id ? { adset_id: adMetadata.adset_id } : {}),
                ...(adMetadata?.adset_name ? { adset_name: adMetadata.adset_name } : {}),
                ...(adMetadata?.campaign_id ? { campaign_id: adMetadata.campaign_id } : {}),
                ...(adMetadata?.campaign_name ? { campaign_name: adMetadata.campaign_name } : {}),
                ...(adMetadata?.optimization_goal ? { optimization_goal: adMetadata.optimization_goal } : {}),
                ...(adMetadata?.destination_type ? { destination_type: adMetadata.destination_type } : {}),
                ...(adMetadata?.publisher_platforms ? { publisher_platforms: adMetadata.publisher_platforms } : {}),
                ...(adMetadata?.campaign_objective ? { campaign_objective: adMetadata.campaign_objective } : {}),
                // Campos não-Meta-oficial no referral (presentes em alguns providers).
                // Enviamos como custom_data custom fields — Meta aceita qualquer chave.
                ...(refCustom ? { ref_custom: refCustom } : {}),
                ...(sourceApp ? { source_app: sourceApp } : {}),  // "facebook" | "instagram"
                ...(adType ? { ad_type: adType } : {}),            // "CTWA" | "CAWC"
                // Intent signal: tipo da 1ª msg (text/audio/image/video/etc).
                ...(firstMsgType ? { first_message_type: firstMsgType } : {}),
                // Temporal context (útil pra segmentação pattern analysis).
                hour_of_day_brt: new Intl.DateTimeFormat('en-US', {
                  timeZone: 'America/Recife', hour: '2-digit', hour12: false,
                }).format(new Date(eventTime * 1000)),
                day_of_week_brt: new Intl.DateTimeFormat('en-US', {
                  timeZone: 'America/Recife', weekday: 'short',
                }).format(new Date(eventTime * 1000)),
              },
            }],
            // Meta best practice: partner_agent identifica plataforma (<23 chars, >=2 letras).
            partner_agent: PARTNER_AGENT,
          }),
        }
      );
      // Log da resposta pra detectar rejeições silenciosas no futuro
      const respBody = await r.json();
      if (respBody.error) {
        console.warn(`[CTWA] ⚠️  CAPI rejected: code=${respBody.error.code} sub=${respBody.error.error_subcode} ${respBody.error.message}`);
      } else {
        console.log(`[CTWA] ✅ CAPI LeadSubmitted fired: ph=${from.slice(-4)} received=${respBody.events_received}`);
      }
    } catch (e) {
      console.warn('[CTWA] CAPI LeadSubmitted failed:', e.message);
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
    // XSS-safe mesmo que nome venha da Meta (defense-in-depth)
    const nomeSafe = escapeHtml(nome);
    const statusSafe = escapeHtml(status);
    const html = `
    <div style="font-family:Arial;max-width:540px;margin:auto">
      <div style="background:#c0392b;padding:16px;border-radius:8px 8px 0 0">
        <h2 style="color:#fff;margin:0">⚠️ Template WhatsApp Pausado</h2>
        <p style="color:#fcc;margin:4px 0 0">${agora}</p>
      </div>
      <div style="background:#fff5f5;padding:16px;border-radius:0 0 8px 8px;border:1px solid #fcc">
        <p><strong>Template:</strong> ${nomeSafe}</p>
        <p><strong>Status:</strong> <span style="color:#c0392b">${statusSafe}</span></p>
        <p style="font-size:12px"><a href="https://business.facebook.com/wa/manage/message-templates/">
          Abrir WhatsApp Manager →</a></p>
      </div>
    </div>`;
    await enviarEmail(`⚠️ Template WA pausado: ${String(nome).replace(/[\r\n]/g, ' ').slice(0, 100)}`, html);
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
    // Log sem o token (evita vazar secret em logs).
    console.log(`[VERIFY] mode=${mode}`);
    // timing-safe comparison evita timing attacks.
    // Bypass 'evolution' removido (legacy Evolution API desabilitada desde 17/04).
    const tokenValid = timingSafeStringEqual(token, VERIFY_TOKEN);
    if (mode === 'subscribe' && tokenValid) {
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
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        // Extrair phone do primeiro message pra identificar o backup
        const firstMsg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        const fromPhone = firstMsg?.from || 'status';
        // Sanitiza phone no path (path traversal defense).
        const safePhone = String(fromPhone).replace(/[^0-9a-z]/gi, '').slice(0, 20) || 'unknown';
        const filename = `webhooks/wa/${ts}_${safePhone}.json`;
        await put(filename, rawBody.toString(), {
          // Store Vercel Blob é public — `access:'private'` lança runtime error.
          // Segurança: addRandomSuffix gera URL não-adivinhável (bearer token),
          // e o path prefix `webhooks/wa/<ts>_<phone>_<suffix>.json` não é
          // enumerável externamente. Blob GC cron limpa após 30 dias.
          access: 'public',
          contentType: 'application/json',
          cacheControlMaxAge: 0,
          addRandomSuffix: true,
        });
        console.log(`[BACKUP] ✅ Salvo: ${filename}`);
      } catch (e) {
        // Backup falhou mas não pode bloquear o fluxo principal
        console.error(`[BACKUP] ❌ Falhou: ${e.message}`);
      }
    };
    // Dispara backup em paralelo (não bloqueia processamento)
    const backupPromise = backupBlob();

    // ── DEDUPLICAÇÃO PERSISTENTE via Vercel Blob (sobrevive cold starts) ──────
    // Bug CRITICAL detectado via AI code review 19/04/2026 (Claude Opus 4.6):
    // Antes usava `new Set()` em memória. Vercel serverless recria a cada invocação.
    // Meta retenta webhooks 7 dias → retry = nova invocação → Set vazio → duplicate.
    // Agora: Blob `dedup/wa/{key}.json` (público + nome previsível — sem PII, só timestamp).
    // TTL via cron blob-gc.js (retention 7d alinhada com Meta webhook retry window).
    // Fallback em memória mantido pra casos onde Blob falha ou não está configurado.
    const memSet = new Set();
    const hasBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
    const dedupCheck = async (key) => {
      if (memSet.has(key)) return true;
      if (!hasBlob) return false;
      try {
        await head(`dedup/wa/${key}.json`);
        return true; // existe → já processado
      } catch {
        return false; // 404 → novo
      }
    };
    const dedupMark = async (key) => {
      memSet.add(key);
      if (!hasBlob) return;
      try {
        await put(`dedup/wa/${key}.json`, JSON.stringify({ t: Date.now() }), {
          access: 'public',
          contentType: 'application/json',
          cacheControlMaxAge: 0,
          allowOverwrite: true,
        });
      } catch (e) {
        console.warn(`[DEDUP] ⚠️ Blob write failed for ${key}: ${e.message}`);
      }
    };

    // Processa eventos por object type
    const objectType = body.object; // whatsapp_business_account, ad_account, page
    console.log(`[WEBHOOK] Object: ${objectType} | Entries: ${body.entry?.length || 0}`);

    for (const entry of body.entry || []) {

      // ── AD ACCOUNT EVENTS (creative_fatigue, with_issues, recommendations) ──
      if (objectType === 'ad_account') {
        for (const change of entry.changes || []) {
          const { field, value } = change;
          const dedup = `${field}_${value?.id || entry.id}_${entry.time}`;
          if (await dedupCheck(dedup)) { console.log(`[DEDUP] ⏭️ Skip ad_account: ${dedup}`); continue; }
          await dedupMark(dedup);

          if (field === 'creative_fatigue') {
            const nivel = value?.fatigue_level || '?';
            const adId = value?.ad_id || value?.id || '?';
            const adName = value?.ad_name || '?';
            console.warn(`[CREATIVE FATIGUE] 🔥 Ad ${adId} (${adName}) → Fadiga: ${nivel}`);
            // escape defensive (ad names vêm da Meta — confiáveis, mas hardening)
            const nivelS = escapeHtml(nivel);
            const adIdS = escapeHtml(adId);
            const adNameS = escapeHtml(adName);
            await enviarEmail(
              `🔥 Creative Fatigue: ${String(adName).replace(/[\r\n]/g, ' ').slice(0, 80)} → ${String(nivel).slice(0, 20)}`,
              `<div style="font-family:Arial;max-width:540px;margin:auto">
                <div style="background:${nivel === 'High' ? '#c0392b' : nivel === 'Medium' ? '#f39c12' : '#3498db'};padding:16px;border-radius:8px 8px 0 0">
                  <h2 style="color:#fff;margin:0">🔥 Creative Fatigue — ${nivelS}</h2>
                </div>
                <div style="background:#f9f9f9;padding:16px;border-radius:0 0 8px 8px;border:1px solid #eee">
                  <p><strong>Ad:</strong> ${adNameS}</p>
                  <p><strong>Ad ID:</strong> ${adIdS}</p>
                  <p><strong>Nível:</strong> <span style="color:${nivel === 'High' ? '#c0392b' : '#f39c12'};font-weight:bold">${nivelS}</span></p>
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
            const levelS = escapeHtml(level);
            const objIdS = escapeHtml(objId);
            const errCodeS = escapeHtml(errCode);
            const errSummaryS = escapeHtml(errSummary);
            const errMsgS = escapeHtml(errMsg);
            await enviarEmail(
              `⚠️ ${String(level).slice(0, 20)} com problema: ${String(errSummary).replace(/[\r\n]/g, ' ').slice(0, 80)}`,
              `<div style="font-family:Arial;max-width:540px;margin:auto">
                <div style="background:#e74c3c;padding:16px;border-radius:8px 8px 0 0">
                  <h2 style="color:#fff;margin:0">⚠️ ${levelS} — WITH_ISSUES</h2>
                </div>
                <div style="background:#fff5f5;padding:16px;border-radius:0 0 8px 8px;border:1px solid #fcc">
                  <p><strong>Tipo:</strong> ${levelS}</p>
                  <p><strong>ID:</strong> ${objIdS}</p>
                  <p><strong>Erro:</strong> ${errSummaryS}</p>
                  <p><strong>Detalhe:</strong> ${errMsgS}</p>
                  <p><strong>Código:</strong> ${errCodeS}</p>
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
                const lr = await fetch(
                  `${GRAPH_BASE}/${leadId}`,
                  { headers: { 'Authorization': `Bearer ${META_TOKEN}` } }
                );
                const ld = await lr.json();
                const fields = ld.field_data || [];
                const nome = fields.find(f => f.name === 'full_name')?.values?.[0] || '?';
                const tel = fields.find(f => f.name === 'phone_number')?.values?.[0] || '?';
                const email = fields.find(f => f.name === 'email')?.values?.[0] || '';
                console.log(`[LEADGEN] ${maskName(nome)} | ${maskPhone(tel)} | ${maskEmail(email)}`);
                // XSS-safe: nome, tel, email podem vir maliciosos via Lead Gen Form
                const nomeLgSafe = escapeHtml(nome);
                const telLgSafe = escapeHtml(tel);
                const emailLgSafe = escapeHtml(email || '');
                const telLgDigits = String(tel || '').replace(/\D/g, '');
                await enviarEmail(
                  `🎯 Lead Nativo — ${String(nome).replace(/[\r\n]/g, ' ').slice(0, 100)} | IceLaser`,
                  `<div style="font-family:Arial;max-width:540px;margin:auto">
                    <div style="background:#27ae60;padding:16px;border-radius:8px 8px 0 0">
                      <h2 style="color:#fff;margin:0">🎯 Novo Lead — Form Nativo</h2>
                    </div>
                    <div style="background:#f0fff4;padding:16px;border-radius:0 0 8px 8px;border:1px solid #c3e6cb">
                      <p><strong>Nome:</strong> ${nomeLgSafe}</p>
                      <p><strong>Telefone:</strong> <a href="https://wa.me/${telLgDigits}">${telLgSafe}</a></p>
                      ${email ? `<p><strong>Email:</strong> ${emailLgSafe}</p>` : ''}
                      <p><strong>Form ID:</strong> ${escapeHtml(formId)}</p>
                      <p><strong>Ad ID:</strong> ${escapeHtml(adId || 'orgânico')}</p>
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
          // Deduplicação por message ID via Blob persistente
          if (msg.id && await dedupCheck(msg.id)) {
            console.log(`[DEDUP] ⏭️ Ignorando msg duplicada: ${msg.id}`);
            continue;
          }
          if (msg.id) await dedupMark(msg.id);

          const from = msg.from;
          let ctwaClid = null;

          // Profile name do WhatsApp (display name que user configurou) —
          // encontrado em value.contacts[0].profile.name quando wa_id == msg.from.
          // CRÍTICO pra matching quality: Meta CAPI LeadSubmitted CTWA envia só
          // ph+geo se não temos nome. Com profile.name podemos enviar fn/ln e
          // advanced matching partials (f5first, fi) → EMQ +0.3 a +0.5.
          let profileName = null;
          if (value.contacts && Array.isArray(value.contacts)) {
            const contact = value.contacts.find(c => c.wa_id === from);
            if (contact && contact.profile && contact.profile.name) {
              profileName = String(contact.profile.name).trim();
            }
          }

          // CTWA — veio de anúncio
          if (msg.referral?.ctwa_clid) {
            ctwaClid = await processarCTWA(from, msg, msg.referral, profileName);
          }

          // Lead via Flow (nfm_reply)
          if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
            await processarLeadFlow(from, msg.interactive.nfm_reply, ctwaClid);
            continue;
          }

          // Texto normal (mascara phone e trunca body pra não vazar PII)
          if (msg.type === 'text') {
            const preview = (msg.text?.body || '').substring(0, 40);
            console.log(`[MSG] ${maskPhone(from)}: ${preview}${preview.length === 40 ? '...' : ''}`);
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
      const headers = { 'Content-Type': 'application/json' };
      // Só assina se APP_SECRET configurado (evita crypto throw)
      if (APP_SECRET) {
        headers['X-Hub-Signature-256'] = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(payload).digest('hex');
      }
      const r = await fetch(CHATWOOT_WA_WEBHOOK, {
        method: 'POST',
        headers,
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
        const metaResp = await fetch(
          `${GRAPH_BASE}/${mediaObj.id}`,
          { headers: { 'Authorization': `Bearer ${META_TOKEN}` } }
        );
        const metaData = await metaResp.json();
        if (!metaData.url) return null;
        const fileResp = await fetch(metaData.url, { headers: { 'Authorization': `Bearer ${META_TOKEN}` } });
        if (!fileResp.ok) return null;
        const buffer = Buffer.from(await fileResp.arrayBuffer());
        const ext = (mediaObj.mime_type || '').split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/gi, '') || 'bin';
        // Sanitiza msg.from (phone) e msg.type pra evitar path traversal
        const safeFrom = String(msg.from || 'unknown').replace(/[^0-9]/g, '').slice(0, 20) || 'unknown';
        const safeType = String(msg.type || 'media').replace(/[^a-z]/gi, '').slice(0, 20);
        const filename = `media/${safeFrom}/${Date.now()}_${safeType}.${ext}`;
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
