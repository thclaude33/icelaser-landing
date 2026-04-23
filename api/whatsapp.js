/**
 * whatsapp.js — Webhook Handler WhatsApp Cloud API
 * Vercel Serverless Function
 *
 * GET  /api/whatsapp  → challenge de verificação Meta
 * POST /api/whatsapp  → eventos (mensagens, flows, template alerts)
 */

import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { put, head, list, del } from '@vercel/blob';
import { PIXEL_ID, GRAPH_BASE } from './_lib/config.js';
import { sha256, timingSafeStringEqual, maskPhone, maskEmail, maskName, escapeHtml, sanitizeHeader } from './_lib/security.js';
import { buildUserData } from './_lib/piiBuilder.js';
import { PARTNER_AGENT } from './_lib/capi.js';
import { sendWAMEvent } from './_lib/capi-wam.js';

const VERIFY_TOKEN    = process.env.WA_VERIFY_TOKEN;
const APP_SECRET      = process.env.META_APP_SECRET;
const EMAIL_FROM      = process.env.EMAIL_FROM  || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS      = process.env.EMAIL_PASS;
const EMAIL_TO        = (process.env.EMAIL_TO   || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');
const META_TOKEN      = process.env.META_ACCESS_TOKEN;       // broad scope — Graph API lookups (ad_id, profile_name, message media)
const CAPI_TOKEN      = process.env.CAPI_DATASET_TOKEN || META_TOKEN;  // dataset-scoped — POST /events CAPI (LeadSubmitted)
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;

// ── AD ACCOUNT FILTER ────────────────────────────────────────────────────────
// Meta BM (122447015946218) entrega webhook ad_account de TODAS as contas do BM.
// IceLaser subscreveu no App nivel BM → recebe events de contas alheias.
// Filtrar por account_id evita alerta/email pra ad de outra conta.
// Ref: https://developers.facebook.com/docs/graph-api/webhooks/reference/ad-account
// account_id vem como string numérica SEM prefixo `act_`.
const ICELASER_ACCOUNT_ID = '790663154114264';

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
// Fix MEDIUM AI review 20/04/2026 (M11): transporter como module-level singleton.
// Antes criava um transporter novo por email (TLS handshake ~200-500ms). Vercel
// reusa o módulo entre invocações warm → singleton amortiza o custo de conexão.
let _mailTransport = null;
function getTransport() {
  if (!_mailTransport && EMAIL_PASS) {
    _mailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_FROM, pass: EMAIL_PASS },
    });
  }
  return _mailTransport;
}
async function enviarEmail(assunto, html) {
  if (!EMAIL_PASS) { console.warn('[EMAIL] EMAIL_PASS não configurado — email ignorado'); return false; }
  try {
    const t = getTransport();
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
async function processarLeadFlow(from, nfmReply, ctwaClid, wamid) {
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
  // Fix LOW AI review 20/04/2026 (L4): se telefone já vem com 55 (E.164), não
  // duplicar prefixo. Meta WA Cloud API envia `from` em formato 5581XXXXXXXXX.
  const waDigits = telDigits.startsWith('55') ? telDigits : '55' + telDigits;
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
              <a href="https://wa.me/${waDigits}" style="color:#25D366;font-weight:bold">${telefoneSafe}</a>
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

  // Fix HIGH AI deep review v2 B2 (whatsapp.js:833) — Opção B:
  // Flow lead (nfm_reply) SEMPRE dispara CAPI LeadSubmitted, mesmo sem CTWA.
  // Flow submitted = signal forte de Lead qualificado (nome + phone + serviço).
  // Sem CTWA → lead orgânico (Andromeda ainda usa pra optimization signals).
  // Com CTWA → segundo event (event_id distinto) com dados completos do form.
  // Meta v25 Conversion Leads spec: LeadSubmitted = dentro business_messaging flow.
  if (CAPI_TOKEN && from && from !== '—') {
    try {
      const telNorm = String(telefone || from).replace(/\D/g, '');
      let firstName = null, lastName = null;
      if (nome && nome !== from) {
        const parts = String(nome).trim().split(/\s+/);
        firstName = parts[0];
        if (parts.length > 1) lastName = parts[parts.length - 1];
      }
      const inferredState = stateFromPhone(from);
      const userData = await buildUserData({
        phone: telNorm || from,
        first_name: firstName || undefined,
        last_name: lastName || undefined,
        city: 'recife',
        state: inferredState,
        country: 'br',
        external_id: from, // phone como identidade estável
      });
      if (ctwaClid) userData.ctwa_clid = ctwaClid;
      if (process.env.META_PAGE_ID) userData.page_id = process.env.META_PAGE_ID;

      // Fix HIGH AI audit 20/04/2026 (whatsapp.js:169): event_id IDEMPOTENTE.
      // Antes: `flow_{phone}_{Date.now()/1000}` — Meta retenta webhook 7 dias → nova
      // invocação → novo eventTime → event_id diferente → duplicata no Meta dataset.
      // Agora: usa wamid (message.id) que é único por mensagem WhatsApp — mesmo retry
      // gera event_id IDÊNTICO → Meta dedup funciona.
      const eventTime = Math.floor(Date.now() / 1000);
      const stableSeed = wamid || `${telNorm || from}_${eventTime}`;
      const eventId = `flow_leadsubmitted_${stableSeed}`;

      const payload = {
        data: [{
          event_name: 'LeadSubmitted',
          event_time: eventTime,
          event_id: eventId,
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          user_data: userData,
          custom_data: {
            // Fix CRITICAL 20/04/2026: event_source: 'crm' é OBRIGATÓRIO per Meta
            // Conversion Leads Payload Spec. Sem isso, eventos não são classificados
            // como Conversion Leads → wizard "integração CRM" nunca completa.
            // https://developers.facebook.com/docs/marketing-api/conversions-api/
            // conversion-leads-integration/payload-specification/
            event_source: 'crm',
            content_name: String(servico || 'Depilacao Laser').slice(0, 100),
            content_category: 'depilacao_laser',
            currency: 'BRL',
            value: 0,
            // Fix MEDIUM 20/04/2026: lead_event_source consistente = 'Chatwoot'
            // (CRM tool name canônico). 'WhatsApp Flow' é descritivo mas não
            // é CRM name — Meta Conversion Leads espera nome do CRM.
            lead_event_source: 'Chatwoot',
            flow_source: 'WhatsApp Flow',  // campo custom pra debug interno
            customer_segmentation: 'new_customer_to_business',
            ...(ctwaClid ? { attribution: 'ctwa' } : { attribution: 'organic' }),
          },
        }],
        partner_agent: PARTNER_AGENT,
      };

      const r = await fetch(`${GRAPH_BASE}/${PIXEL_ID}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CAPI_TOKEN}` },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const txt = (await r.text()).substring(0, 200);
        console.error(`[FLOW LeadSubmitted] Meta API ${r.status}: ${txt}`);
      } else {
        const respBody = await r.json();
        if (respBody?.error) {
          console.error('[FLOW LeadSubmitted] CAPI error:', respBody.error.message);
        } else {
          // Fix CRITICAL 20/04/2026 (silent failure): log messages[] + silent drops.
          const eventsReceived = respBody.events_received ?? 0;
          if (Array.isArray(respBody.messages) && respBody.messages.length > 0) {
            console.warn(`[CAPI WARN FLOW] received=${eventsReceived} messages=${JSON.stringify(respBody.messages)} fbtrace=${respBody.fbtrace_id || 'n/a'}`);
          }
          if (eventsReceived === 0) {
            console.error(`[CAPI SILENT_DROP FLOW] received=0 fbtrace=${respBody.fbtrace_id || 'n/a'}`);
          }
          console.log(`[FLOW LeadSubmitted] ✅ ph=${maskPhone(from)} ctwa=${!!ctwaClid} received=${eventsReceived}`);
        }
      }

      // WAM Dataset (WhatsApp Marketing Message Event Sharing) — disparar EM
      // PARALELO quando ctwa_clid presente. Dataset exige ctwa_clid + page_id +
      // action_source=business_messaging + event_name padrão Meta.
      // Mesmo event_id permite dedup cross-dataset se Meta implementar.
      if (ctwaClid) {
        try {
          const wamResp = await sendWAMEvent({
            event_name: 'LeadSubmitted',
            event_id: eventId,
            event_time: eventTime,
            user_data: { ...userData },
            custom_data: {
              event_source: 'crm',
              lead_event_source: 'Chatwoot',
              content_name: String(servico || 'Depilacao Laser').slice(0, 100),
              content_category: 'depilacao_laser',
              customer_segmentation: 'new_customer_to_business',
              flow_source: 'WhatsApp Flow',
            },
          });
          if (wamResp?.skipped) {
            console.log(`[WAM FLOW] skipped: ${wamResp.skipped}`);
          }
        } catch (wamErr) {
          console.error('[WAM FLOW] exception:', wamErr.message);
        }
      }
    } catch (e) {
      console.error('[FLOW LeadSubmitted] exception:', e.message);
    }
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
    // Meta Graph API: nó Ad NÃO expõe adset_name/campaign_name como top-level —
    // erro #100. Pegar via expansion adset{name}, campaign{name} (relacionamento).
    // Captura EXPANDIDA pra atribuição máxima (creative testing, bid analysis, compliance).
    // Fix P1 (AI review): creative.body/image/CTA pra creative testing real (sem isso só temos label).
    const adFields = 'name,effective_status,configured_status,adset_id,campaign_id,account_id,creative{id,name,thumbnail_url,body,image_url,video_id,call_to_action_type}';
    const adsetFields = 'name,optimization_goal,destination_type,billing_event,bid_strategy,attribution_spec,start_time,end_time,daily_budget,lifetime_budget,effective_status,promoted_object,targeting{age_min,age_max,genders,publisher_platforms,facebook_positions,instagram_positions,messenger_positions,geo_locations}';
    const campaignFields = 'name,objective,buying_type,special_ad_categories,daily_budget,lifetime_budget,bid_strategy,start_time,stop_time,effective_status,smart_promotion_type,pacing_type';
    const fields = `${adFields},adset{${adsetFields}},campaign{${campaignFields}}`;
    const r = await fetch(`${GRAPH_BASE}/${adId}?fields=${fields}`, {
      headers: { 'Authorization': `Bearer ${META_TOKEN}` },
    });
    const data = await r.json();
    if (data.error) {
      console.warn(`[CTWA AD-LOOKUP] ${adId}: ${data.error.message}`);
      return null;
    }
    const adset = data.adset || {};
    const campaign = data.campaign || {};
    const targeting = adset.targeting || {};
    const creative = data.creative || {};
    const promoted = adset.promoted_object || {};
    const attrSpec = Array.isArray(adset.attribution_spec) ? adset.attribution_spec[0] : null;
    const geoCustom = Array.isArray(targeting.geo_locations?.custom_locations)
      ? targeting.geo_locations.custom_locations[0] : null;
    const joinArr = (a) => Array.isArray(a) ? a.join(',') : null;

    return {
      // ── AD ──
      ad_id: adId,
      ad_name: data.name || null,
      ad_status: data.effective_status || null,                    // ACTIVE/PAUSED/etc
      ad_configured_status: data.configured_status || null,
      account_id: data.account_id || null,
      // ── CREATIVE (key pra creative testing analysis) ──
      creative_id: creative.id || null,
      creative_name: creative.name || null,
      creative_thumbnail: creative.thumbnail_url || null,
      creative_body: creative.body ? String(creative.body).slice(0, 500) : null,    // truncate pra payload size
      creative_image_url: creative.image_url || null,
      creative_video_id: creative.video_id || null,
      creative_cta: creative.call_to_action_type || null,                            // SEND_WHATSAPP_MESSAGE, etc
      // ── ADSET ──
      adset_id: data.adset_id || null,
      adset_name: adset.name || null,
      adset_status: adset.effective_status || null,
      optimization_goal: adset.optimization_goal || null,          // CONVERSATIONS, LEAD_GENERATION, etc
      destination_type: adset.destination_type || null,            // WHATSAPP, ON_AD, etc
      billing_event: adset.billing_event || null,                  // IMPRESSIONS, LINK_CLICKS
      bid_strategy: adset.bid_strategy || campaign.bid_strategy || null, // LOWEST_COST_WITHOUT_CAP, COST_CAP, etc
      attribution_window_event: attrSpec?.event_type || null,      // CLICK_THROUGH, VIEW_THROUGH
      attribution_window_days: attrSpec?.window_days || null,      // 1, 7
      adset_daily_budget_cents: adset.daily_budget ? parseInt(adset.daily_budget, 10) : null,
      adset_lifetime_budget_cents: adset.lifetime_budget ? parseInt(adset.lifetime_budget, 10) : null,
      adset_start_time: adset.start_time || null,
      adset_end_time: adset.end_time || null,
      promoted_page_id: promoted.page_id || null,
      promoted_wa_phone_id: promoted.whats_app_business_phone_number_id || null,
      promoted_wa_phone_number: promoted.whatsapp_phone_number || null,
      // ── PLACEMENTS ──
      publisher_platforms: joinArr(targeting.publisher_platforms),  // facebook,instagram,whatsapp
      facebook_positions: joinArr(targeting.facebook_positions),    // feed,stories,reels
      instagram_positions: joinArr(targeting.instagram_positions),
      messenger_positions: joinArr(targeting.messenger_positions),
      // ── TARGETING (cohort analysis) ──
      // Fix P2 (AI review): remover lat/lng/radius — vaza estratégia de geofencing
      // do anunciante e Meta restringe coords em custom_data em algumas regiões.
      // Manter só country + region/city IDs (anonimizados).
      target_age_min: targeting.age_min || null,
      target_age_max: targeting.age_max || null,
      target_genders: joinArr(targeting.genders),                  // 1=male, 2=female
      target_geo_country: geoCustom?.country || null,
      target_geo_region_id: geoCustom?.region_id || null,
      target_geo_city_id: geoCustom?.primary_city_id || null,
      // ── CAMPAIGN ──
      campaign_id: data.campaign_id || null,
      campaign_name: campaign.name || null,
      campaign_status: campaign.effective_status || null,
      campaign_objective: campaign.objective || null,              // OUTCOME_ENGAGEMENT, OUTCOME_SALES
      buying_type: campaign.buying_type || null,                   // AUCTION, RESERVED
      campaign_daily_budget_cents: campaign.daily_budget ? parseInt(campaign.daily_budget, 10) : null,
      campaign_lifetime_budget_cents: campaign.lifetime_budget ? parseInt(campaign.lifetime_budget, 10) : null,
      campaign_start_time: campaign.start_time || null,
      campaign_stop_time: campaign.stop_time || null,
      special_ad_categories: joinArr(campaign.special_ad_categories), // HOUSING, EMPLOYMENT, CREDIT (compliance)
      smart_promotion_type: campaign.smart_promotion_type || null, // GUIDED_CREATION, etc
      pacing_type: joinArr(campaign.pacing_type),                  // standard, day_parting
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

      // Enriquecimento 21/04/2026 (Fix 22→30 campos per checkup):
      // - hour_brt / day_of_week: janela de engajamento (Recife UTC-3)
      // - f5first / fi: advanced matching partials (Meta CAPI user_data) derivados do profile_name
      // - page_id: top-level (antes só em ad_metadata.promoted_page_id)
      // Docs: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
      const nowBrt = new Date(Date.now() - 3 * 60 * 60 * 1000); // UTC→BRT (UTC-3)
      const hourBrt = nowBrt.getUTCHours();
      const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const dayOfWeek = dayNames[nowBrt.getUTCDay()];
      const profileClean = (profileName || '').toLowerCase().trim().replace(/\s+/g, ' ');
      const f5first = profileClean ? profileClean.slice(0, 5) : null;
      const fi = profileClean ? profileClean.charAt(0) : null;
      const pageId = adMetadata?.promoted_page_id || null;

      await put(`ctwa/${safeFrom}.json`, JSON.stringify({
        ctwa_clid: clid,
        phone: safeFrom,
        profile_name: profileName || null,
        state: stateFromPhone(safeFrom),  // inferido do DDD brasileiro
        // ── TIME ENRICHMENT (BRT) ──
        hour_brt: hourBrt,                          // 0-23 horário Recife
        day_of_week: dayOfWeek,                     // monday..sunday
        // ── CAPI ADVANCED MATCHING PARTIALS (user_data) ──
        f5first: f5first,                           // primeiros 5 chars nome (EMQ boost)
        fi: fi,                                     // first initial
        // ── REFERRAL CTWA (Meta schema) ──
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
        // ── PAGE ID top-level ──
        page_id: pageId,
        // ── GRAPH API METADATA (spread top-level dos campos-chave) ──
        // ad_metadata continua aninhado pra detalhes, mas expomos os principais
        // pra query direta no Blob.
        publisher_platforms: adMetadata?.publisher_platforms || null,
        facebook_positions: adMetadata?.facebook_positions || null,
        instagram_positions: adMetadata?.instagram_positions || null,
        optimization_goal: adMetadata?.optimization_goal || null,   // CONVERSATIONS, LEAD_GENERATION
        destination_type: adMetadata?.destination_type || null,     // WHATSAPP, ON_AD
        campaign_objective: adMetadata?.campaign_objective || null, // OUTCOME_ENGAGEMENT
        campaign_id: adMetadata?.campaign_id || null,
        campaign_name: adMetadata?.campaign_name || null,
        adset_id: adMetadata?.adset_id || null,
        adset_name: adMetadata?.adset_name || null,
        ad_id: adMetadata?.ad_id || sourceId || null,
        ad_name: adMetadata?.ad_name || null,
        ad_metadata: adMetadata,
        timestamp: ts,
        // Fix MEDIUM AI review 20/04/2026 (M10): addRandomSuffix:true cria path
        // único por click CTWA. Antes ctwa/{phone}.json + allowOverwrite:true
        // sobrescrevia clicks anteriores — se user clicava em 2 ads CTWA, o 2º
        // apagava a attribution do 1º. Agora mantém histórico. Bônus M5-like:
        // previne enumeration do pathname. Recovery em crm-webhook.js usa
        // list({prefix:'ctwa/'})+iterate, funciona com suffix random.
      }), { access: 'public', addRandomSuffix: true, contentType: 'application/json' });
      console.log(`[CTWA] Saved to Blob: ctwa/${safeFrom}-*.json (profile=${!!profileName}, ad_meta=${!!adMetadata})`);
    } catch (e) {
      console.warn('[CTWA] Blob save failed:', e.message);
    }
  }

  // Disparar CAPI LeadSubmitted (ContactStarted) com telefone + fbc derivado do ctwa_clid
  // Meta oficial (2026): business_messaging aceita 14 eventos; "Lead" NÃO está — "LeadSubmitted" é o correto.
  // Também OBRIGATÓRIO: messaging_channel = "whatsapp" (sem ele, erro 2804063).
  // Este evento representa o 1º contato do lead via CTWA ad — atribuição do click.
  // (Lead qualificado real é disparado depois pelo crm-webhook via label lead_quente.)
  // Fix HIGH AI review 19/04/2026: usar CAPI_TOKEN (dataset-scoped + fallback
  // META_TOKEN). Antes checava só META_TOKEN — se só CAPI_DATASET_TOKEN estava
  // setado, LeadSubmitted CTWA não disparava (lead perdia attribution Meta).
  if (clid && from && CAPI_TOKEN) {
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
      // AI sanity deep v3 REVERT: manter `ctwa_${stableSeed}` pra preservar dedup
      // histórico com events já enviados. Meta retenta webhooks 7 dias — mudança
      // de formato geraria event_id diferente em retries → duplicatas no Meta.
      // Collision com futuros tipos (LeadPurchase etc) é problema hipotético
      // que pode ser resolvido quando/se precisar via namespace explícito.
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
      // Fix MEDIUM AI review 20/04/2026 (M12): remover gender:'f' hardcoded.
      // Target IceLaser é 95%+ mulheres, mas homens podem clicar CTWA (parceiros,
      // gift, curiosos). Enviar gender errado degrada EMQ (Meta falha match com
      // perfil feminino). Meta prefere ausência de dado a dado incorreto.
      const userData = await buildUserData({
        phone: from,
        first_name: firstName || undefined,
        last_name: lastName || undefined,
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
                // Fix CRITICAL 20/04/2026: event_source: 'crm' OBRIGATÓRIO per Meta
                // Conversion Leads spec. IceLaser Chatwoot = CRM → classificação.
                event_source: 'crm',
                // Fix MEDIUM 20/04/2026: CRM name canônico 'Chatwoot'
                lead_event_source: 'Chatwoot',
                ctwa_source: 'WhatsApp CTWA',  // debug interno
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
        // Fix CRITICAL 20/04/2026 (silent failure): log messages[] + silent drops.
        const eventsReceived = respBody.events_received ?? 0;
        if (Array.isArray(respBody.messages) && respBody.messages.length > 0) {
          console.warn(`[CAPI WARN CTWA] received=${eventsReceived} messages=${JSON.stringify(respBody.messages)} fbtrace=${respBody.fbtrace_id || 'n/a'}`);
        }
        if (eventsReceived === 0) {
          console.error(`[CAPI SILENT_DROP CTWA] ph=${maskPhone(from)} received=0 fbtrace=${respBody.fbtrace_id || 'n/a'}`);
        }
        // Fix LOW AI review 20/04/2026 (L6): usar maskPhone em vez de slice(-4)
        // pra consistência com o resto do código (PII mascarado em logs).
        console.log(`[CTWA] ✅ CAPI LeadSubmitted fired: ph=${maskPhone(from)} received=${eventsReceived}`);
      }

      // Fix 21/04/2026: FAN-OUT pro WAM Dataset.
      // Antes CTWA só enviava pro Pixel principal (PIXEL_ID). WAM LeadSubmitted
      // ficava órfão — user viu Lead count 2 via Browser, nenhum via CAPI CTWA.
      // WAM é CAPI oficial Meta pra business_messaging → dedup cross-dataset
      // via mesmo event_id. Custom_data + user_data idênticos.
      try {
        const wamResp = await sendWAMEvent({
          event_name: 'LeadSubmitted',
          event_id: eventId,
          event_time: eventTime,
          user_data: { ...userData },
          custom_data: {
            event_source: 'crm',
            lead_event_source: 'Chatwoot',
            ctwa_source: 'WhatsApp CTWA',
            source_url: sourceUrl,
            content_name: 'CTWA Contact Started - WhatsApp',
            content_category: 'depilacao_laser',
            customer_segmentation: 'new_customer_to_business',
            ...(adMetadata?.ad_id ? { ad_id: adMetadata.ad_id } : {}),
            ...(adMetadata?.adset_id ? { adset_id: adMetadata.adset_id } : {}),
            ...(adMetadata?.campaign_id ? { campaign_id: adMetadata.campaign_id } : {}),
            ...(adMetadata?.optimization_goal ? { optimization_goal: adMetadata.optimization_goal } : {}),
            ...(adMetadata?.campaign_objective ? { campaign_objective: adMetadata.campaign_objective } : {}),
          },
        });
        if (wamResp?.skipped) console.log(`[WAM CTWA] skipped: ${wamResp.skipped}`);
        else if (wamResp?.error) console.warn(`[WAM CTWA] error: ${wamResp.error.message}`);
        else console.log(`[WAM CTWA] ✅ received=${wamResp?.events_received} trace=${wamResp?.fbtrace_id}`);
      } catch (wamErr) {
        console.error('[WAM CTWA] exception:', wamErr.message);
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
  // Fix MEDIUM AI review 20/04/2026 (M8): sanitizar params do template.
  //  - nome pode ser null/undefined (TypeError em .split)
  //  - Meta limita params a 1024 chars — truncar pra evitar rejeição
  const primeiroNome = String(nome || '').trim().split(/\s+/)[0].slice(0, 60) || 'Cliente';
  const servicoSafe = String(servico || 'Depilação Laser').slice(0, 100);
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
          { type: 'text', text: primeiroNome },
          { type: 'text', text: servicoSafe },
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
      const hasToken = !!process.env.BLOB_READ_WRITE_TOKEN;
      console.log(`[BACKUP] start: object=${body.object} hasToken=${hasToken}`);
      if (!hasToken) { console.error('[BACKUP] ❌ BLOB_READ_WRITE_TOKEN ausente em runtime'); return; }
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const firstMsg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        const fromPhone = firstMsg?.from || 'status';
        const safePhone = String(fromPhone).replace(/[^0-9a-z]/gi, '').slice(0, 20) || 'unknown';
        const pathPrefix = body.object === 'ad_account' ? 'webhooks/ad_account'
                        : body.object === 'page'       ? 'webhooks/page'
                        : 'webhooks/wa';
        const filename = `${pathPrefix}/${ts}_${safePhone}.json`;
        console.log(`[BACKUP] trying put: ${filename} (${rawBody.length} bytes)`);
        const result = await put(filename, rawBody.toString(), {
          access: 'public',
          contentType: 'application/json',
          cacheControlMaxAge: 0,
          addRandomSuffix: true,
        });
        console.log(`[BACKUP] ✅ OK: ${filename} url=${result?.url?.slice(0,60)}`);
      } catch (e) {
        console.error(`[BACKUP] ❌ put() threw: name=${e.name} msg=${e.message} code=${e.code} stack=${e.stack?.slice(0,200)}`);
      }
    };
    // Fix 21/04/2026 v2 (AI Gateway Opus 4): backupBlob MOVIDO pro FINAL do
    // handler (antes do res.json). Hipótese: Vercel serverless pode terminar
    // async ops entre await inicial e res.status(200). dedupMark funciona pq
    // é chamado DURANTE o loop (zona "quente"). backupBlob antes de tudo
    // ficava órfão. Isolando execução no final garante co-habitação com
    // dedupMark na mesma zona de execução. Ver final da função.
    // (disparo real no final do handler)

    // ── DEDUPLICAÇÃO PERSISTENTE via Vercel Blob (sobrevive cold starts) ──────
    // Bug CRITICAL detectado via AI code review 19/04/2026 (Claude Opus 4.6):
    // Antes usava `new Set()` em memória. Vercel serverless recria a cada invocação.
    // Meta retenta webhooks 7 dias → retry = nova invocação → Set vazio → duplicate.
    // Agora: Blob `dedup/wa/{key}.json` (público + nome previsível — sem PII, só timestamp).
    // TTL via cron blob-gc.js (retention 7d alinhada com Meta webhook retry window).
    // Fallback em memória mantido pra casos onde Blob falha ou não está configurado.
    const memSet = new Set();
    const hasBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
    // AI sanity deep v3 REVERT: manter "return false (new)" em TODO erro do head().
    // Reasoning: se Blob infra down, original retornava false → processa evento
    // + tenta put() depois. Se tudo falhar, pior caso é duplicata ocasional
    // (recuperável via deduplicação Meta event_id). Alternativa "return true"
    // silenciosamente perderia eventos novos em infra outage → UNRECOVERABLE.
    // Event_id dedup Meta já protege contra duplicatas na camada CAPI.
    const dedupCheck = async (key) => {
      if (memSet.has(key)) return true;
      if (!hasBlob) return false;
      try {
        await head(`dedup/wa/${key}.json`);
        return true; // existe → já processado
      } catch {
        return false; // 404 ou infra error → processa (event_id dedup protege).
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
          // Fix 21/04/2026 (AI Gateway review): filtrar contas alheias ANTES
          // de dedup/processamento. BM 122447015946218 entrega eventos de todas
          // as ad accounts do Business → IceLaser só deve alertar sobre a dela.
          // account_id vem string sem prefixo `act_` (Meta webhook schema).
          const accId = value?.account_id ? String(value.account_id) : null;
          if (accId && accId !== ICELASER_ACCOUNT_ID) {
            console.log(`[WEBHOOK] Skip ad_account: conta ${accId} ≠ IceLaser`);
            continue;
          }
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
            // Fix 21/04/2026: warn em vez de error. Ad com issue é evento de
            // negócio (criativo rejeitado/aspect ratio), não falha do webhook.
            // `error` level poluía Dashboard/Log Drain misturando com 5xx reais.
            console.warn(`[WITH_ISSUES] ⚠️ ${level} ${objId}: ${errSummary}`);
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
        // Fix HIGH 19/04/2026: `continue` em vez de `return` pra permitir Meta
        // batch múltiplas entries no mesmo payload. Antes só primeira era processada.
        continue;
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

            // Fix CRITICAL #3 AI review (20/04/2026): Dead Letter Queue via Blob.
            // Salvar payload imediatamente como "pending" pra sobreviver cold-start,
            // timeout, Railway down etc. Cron /api/cron/process-leadgen reprocessa
            // blobs pending a cada 5min até sucesso ou TTL 30d.
            // NÃO toca CAPI payload — só garante que lead NUNCA se perde.
            if (leadId && process.env.BLOB_READ_WRITE_TOKEN) {
              try {
                const dlqBlobPath = `leadgen/pending/${leadId}.json`;
                await put(dlqBlobPath, JSON.stringify({
                  leadgen_id: String(leadId),
                  form_id: String(formId || ''),
                  ad_id: String(adId || ''),
                  created_time: created,
                  page_id: value?.page_id || '',
                  received_at: new Date().toISOString(),
                  processed: false,
                  retry_count: 0,
                }), {
                  access: 'public',
                  addRandomSuffix: false,  // idempotente — mesma leadgen_id reescreve
                  contentType: 'application/json',
                });
                console.log(`[LEADGEN DLQ] ✅ Payload salvo em ${dlqBlobPath}`);
              } catch (dlqErr) {
                // Fix MEDIUM #6 AI review 20/04: alerta diferenciado quando Blob falha.
                // Safety net quebrada — se Chatwoot também falhar, lead se perde.
                console.error(`[LEADGEN DLQ ALERT] 🚨 SAFETY NET BROKEN — blob save failed: ${dlqErr.message} lead_id=${leadId}`);
                // Emitir email de alerta (fire-and-forget, não bloquante)
                try {
                  enviarEmail(
                    `🚨 ALERT: Blob DLQ failure — lead ${leadId} sem safety net`,
                    `<p><strong>Blob save failed</strong>: ${escapeHtml(dlqErr.message)}</p><p>Lead ID: ${escapeHtml(String(leadId))}</p><p>Se Chatwoot/CAPI também falharem, este lead SE PERDE.</p><p>Investigar BLOB_READ_WRITE_TOKEN e Vercel Blob status.</p>`
                  ).catch(() => {});
                } catch {}
              }
            }

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
                // Fix AI review CRITICAL 20/04: nunca logar PII raw (LGPD). Mask helpers
                // já existem em _lib/security.js — já usamos aqui, bom.
                console.log(`[LEADGEN] ${maskName(nome)} | ${maskPhone(tel)} | ${maskEmail(email)}`);
                // Fix AI review HIGH 20/04: extrair TODOS os field_data como custom_attributes
                // (ex: "procedimento_interesse", "horario_preferido") pra atendente no Chatwoot.
                const extraFields = {};
                fields.forEach(f => {
                  if (!['full_name', 'phone_number', 'email'].includes(f.name)) {
                    extraFields[f.name] = f.values?.[0] || '';
                  }
                });
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

                // Fix CRITICAL 20/04/2026 (AI review): lead sem phone E sem email
                // → user_data seria empty, EMQ cai pra 0, Meta rejeita silenciosamente.
                const hasContactData = (tel && tel !== '?' && !String(tel).includes('dummy'))
                  || (email && email.includes('@'));
                if (!hasContactData) {
                  console.warn(`[LEADGEN] lead ${leadId} sem phone/email válidos — criando só contato (sem CAPI)`);
                }

                // Fix CRITICAL 20/04/2026 (wizard CRM setup): CRIAR contato + conversa no
                // Chatwoot quando lead nativo Meta chega. Meta wizard "Etapa 2: confirme se
                // o lead de verificação está no seu CRM" exige que lead entregue
                // automaticamente no CRM como CONVERSA (não só contato).
                //
                // Pipeline (20/04/2026 15:10 BRT):
                //  1. Dedup: procurar contato existente por identifier=leadgen_{id}
                //  2. Se não existe: criar contato com name/phone/email/custom_attributes
                //  3. Associar contato ao inbox API "Meta Lead Ads" (id=8)
                //  4. Criar conversa com mensagem inicial contendo dados do lead
                //
                // Fix race condition: dedup previne duplicatas se Meta webhook retry.
                const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;
                const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
                const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
                const CHATWOOT_LEADS_INBOX_ID = process.env.CHATWOOT_LEADS_INBOX_ID || '8';
                const cwHeaders = {
                  'Content-Type': 'application/json',
                  'api_access_token': CHATWOOT_API_TOKEN,
                };
                if (CHATWOOT_API_TOKEN && CHATWOOT_BASE_URL && leadId) {
                  try {
                    const identifier = `leadgen_${leadId}`;
                    // Fix 20/04/2026: AbortController 8s timeout em TODOS fetches
                    // Railway Chatwoot pode ter cold start >10s → mataria Vercel function.
                    const fetchCw = (url, opts = {}, timeoutMs = 8000) => {
                      const ctrl = new AbortController();
                      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
                      return fetch(url, { ...opts, signal: ctrl.signal })
                        .finally(() => clearTimeout(timer));
                    };
                    // 1. DEDUP Stage 1: por leadgen_{id} identifier (mesmo webhook retry)
                    const filterResp = await fetchCw(
                      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(identifier)}`,
                      { headers: cwHeaders }
                    );
                    const filterJson = await filterResp.json();
                    let contactId = null;
                    if (filterJson?.payload?.length > 0) {
                      const match = filterJson.payload.find(c => c.identifier === identifier);
                      if (match) contactId = match.id;
                    }

                    // Fix MEDIUM #12 AI review 20/04: DEDUP Stage 2 por phone/email.
                    // Fix MEDIUM #3 AI review 20/04 DEFINITIVO: search?q= é FULL-TEXT (contains).
                    // Validar exact match antes de usar contactId (evita match errado).
                    if (!contactId && (tel || email)) {
                      const emailNorm = email && email.includes('@') ? email.trim().toLowerCase() : null;
                      const phoneDigits = String(tel || '').replace(/\D/g, '');
                      const phoneSuffix = phoneDigits.length >= 10 ? phoneDigits.slice(-11) : null;
                      const searchTerm = emailNorm || phoneSuffix;
                      if (searchTerm) {
                        try {
                          const altResp = await fetchCw(
                            `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(searchTerm)}`,
                            { headers: cwHeaders }, 5000
                          );
                          const altJson = await altResp.json();
                          // Exact match validation: iterar payload e confirmar phone/email bate
                          for (const cand of (altJson?.payload || [])) {
                            const candEmail = (cand.email || '').trim().toLowerCase();
                            const candPhoneDigits = String(cand.phone_number || '').replace(/\D/g, '');
                            if (emailNorm && candEmail === emailNorm) {
                              contactId = cand.id;
                              console.log(`[LEADGEN→CHATWOOT] ℹ️ Contato encontrado por EMAIL exato id=${contactId} lead_id=${leadId}`);
                              break;
                            }
                            if (phoneSuffix && candPhoneDigits.endsWith(phoneSuffix)) {
                              contactId = cand.id;
                              console.log(`[LEADGEN→CHATWOOT] ℹ️ Contato encontrado por PHONE suffix exato id=${contactId} lead_id=${leadId}`);
                              break;
                            }
                          }
                        } catch { /* fallback pra criar novo */ }
                      }
                    }

                    if (!contactId) {
                      // 2. Criar contato novo
                      const digits = String(tel || '').replace(/\D/g, '');
                      const e164 = digits ? (digits.startsWith('55') ? `+${digits}` : `+55${digits}`) : null;
                      const contactBody = {
                        inbox_id: Number(CHATWOOT_LEADS_INBOX_ID),
                        name: String(nome || 'Lead Meta').slice(0, 100),
                        identifier,
                        ...(e164 ? { phone_number: e164 } : {}),
                        ...(email && email.includes('@') ? { email } : {}),
                        custom_attributes: {
                          leadgen_id: String(leadId),
                          leadgen_form_id: String(formId || ''),
                          leadgen_ad_id: String(adId || ''),
                          lead_source: 'Meta Lead Ad',
                          created_at_meta: new Date().toISOString(),
                          // Fix AI review HIGH 20/04: propagar campos custom do form
                          // (procedimento, horario, etc) pra atendente ver no Chatwoot.
                          ...extraFields,
                        },
                      };
                      const createResp = await fetchCw(
                        `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
                        { method: 'POST', headers: cwHeaders, body: JSON.stringify(contactBody) }
                      );
                      const createJson = await createResp.json();
                      contactId = createJson?.payload?.contact?.id;
                      if (contactId) {
                        console.log(`[LEADGEN→CHATWOOT] ✅ Contato criado id=${contactId} lead_id=${leadId}`);
                      } else {
                        console.warn(`[LEADGEN→CHATWOOT] ⚠️ createContact resp=${JSON.stringify(createJson).slice(0, 250)}`);
                      }
                    } else {
                      console.log(`[LEADGEN→CHATWOOT] ℹ️ Contato existente id=${contactId} lead_id=${leadId}`);
                      // Garantir que contato está vinculado ao inbox Lead Ads
                      await fetchCw(
                        `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`,
                        { method: 'POST', headers: cwHeaders, body: JSON.stringify({ inbox_id: Number(CHATWOOT_LEADS_INBOX_ID) }) },
                        5000
                      ).catch(() => {});
                    }

                    // 3. Criar CONVERSA pra o lead aparecer no inbox
                    // Fix HIGH #1+2 AI review 20/04/2026: DEDUP conversa aberta existente.
                    // Evidence: 4 conversas pro mesmo contato 235 (233, 235, 236, 241) por
                    // retries Meta + cron paralelo sem check. Agora: se contato já tem
                    // conversa open no inbox 8 → append mensagem em vez de criar nova.
                    let existingConvId = null;
                    if (contactId) {
                      try {
                        const convListResp = await fetchCw(
                          `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`,
                          { headers: cwHeaders }, 5000
                        );
                        const convListJson = await convListResp.json();
                        const openConvs = (convListJson?.payload || []).filter(c =>
                          c.inbox_id === Number(CHATWOOT_LEADS_INBOX_ID) && c.status === 'open'
                        );
                        if (openConvs.length > 0) {
                          existingConvId = openConvs[0].id;
                          console.log(`[LEADGEN→CHATWOOT] ℹ️ Conversa open existente id=${existingConvId} no inbox 8 — reusando`);
                        }
                      } catch (e) {
                        console.warn(`[LEADGEN→CHATWOOT] conv list failed (${e.message}) — criando nova`);
                      }
                    }
                    if (contactId) {
                      const msg = [
                        '🎯 Novo Lead Meta Ads',
                        '',
                        `Nome: ${nome}`,
                        email ? `Email: ${email}` : null,
                        tel ? `Telefone: ${tel}` : null,
                        // Fix AI review HIGH: campos custom do form (procedimento, horário, etc)
                        ...Object.entries(extraFields)
                          .filter(([_, v]) => v)
                          .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`),
                        '',
                        `Lead ID: ${leadId}`,
                        `Form: ${formId || '-'}`,
                        adId ? `Ad ID: ${adId}` : null,
                        `Origem: Meta Lead Ad`,
                        `Recebido: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' })}`,
                      ].filter(Boolean).join('\n');
                      let convJson = null;
                      if (existingConvId) {
                        // Append mensagem na conversa existente (idempotent via retry — Meta manda msg duplicada
                        // SÓ na primeira retry; subsequentes serão dedup'd pelo Chatwoot — mas conversa nova NÃO).
                        const msgResp = await fetchCw(
                          `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${existingConvId}/messages`,
                          { method: 'POST', headers: cwHeaders, body: JSON.stringify({ content: msg, message_type: 'incoming' }) }
                        );
                        convJson = { id: existingConvId, appended: msgResp.ok };
                        console.log(`[LEADGEN→CHATWOOT] ✅ Msg append em conversa existente id=${existingConvId}`);
                      } else {
                        const convBody = {
                          source_id: identifier,
                          inbox_id: Number(CHATWOOT_LEADS_INBOX_ID),
                          contact_id: contactId,
                          status: 'open',
                          message: { content: msg, message_type: 'incoming' },
                        };
                        const convResp = await fetchCw(
                          `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
                          { method: 'POST', headers: cwHeaders, body: JSON.stringify(convBody) }
                        );
                        convJson = await convResp.json();
                      }
                      if (convJson?.id) {
                        console.log(`[LEADGEN→CHATWOOT] ✅ Conversa OK id=${convJson.id} contact=${contactId}`);
                        // Fix DLQ CRITICAL #3: marcar Blob como processed ao sucesso.
                        // Fix MEDIUM #5 AI review: delete pending blob pra prevenir list overflow.
                        if (process.env.BLOB_READ_WRITE_TOKEN) {
                          try {
                            await put(`leadgen/processed/${leadId}.json`, JSON.stringify({
                              leadgen_id: String(leadId),
                              contact_id: contactId,
                              conversation_id: convJson.id,
                              processed_at: new Date().toISOString(),
                            }), { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
                            // Delete pending blob — cleanup (evita list overflow)
                            try {
                              const pendingBlobs = await list({ prefix: `leadgen/pending/${leadId}.json`, limit: 1 });
                              if (pendingBlobs.blobs?.[0]?.url) {
                                await del(pendingBlobs.blobs[0].url);
                              }
                            } catch { /* swallow */ }
                          } catch { /* swallow — não crítico */ }
                        }
                      } else {
                        console.warn(`[LEADGEN→CHATWOOT] ⚠️ createConversation resp=${JSON.stringify(convJson).slice(0, 250)}`);
                      }
                    }
                  } catch (chatwootErr) {
                    console.error(`[LEADGEN→CHATWOOT] exception: ${chatwootErr.message}`);
                  }
                } else {
                  console.warn(`[LEADGEN→CHATWOOT] skipped: CHATWOOT_API_TOKEN=${!!CHATWOOT_API_TOKEN} CHATWOOT_BASE_URL=${!!CHATWOOT_BASE_URL}`);
                }
                // Fix CRITICAL 20/04/2026 (wizard CRM setup): disparar CAPI Lead event quando lead nativo
                // Meta Lead Ads entra via webhook leadgen. Antes: só enviava email.
                // Agora: CAPI event com lead_id 15-17 digits REAL (conforme Meta spec).
                // Isso completa o funil Conversion Leads: Lead → CompleteRegistration (CRM
                // quando stage avança) → Purchase (CRM compra).
                //
                // Fix AI review 20/04 CRITICAL #5: skip CAPI quando sem dados de contato
                // (phone/email) — EMQ despenca pra 0, Meta degrada match rate.
                if (CAPI_TOKEN && leadId && hasContactData) {
                  try {
                    const telDigits = String(tel || '').replace(/\D/g, '');
                    let leadFirstName = null, leadLastName = null;
                    if (nome && nome !== '?') {
                      const parts = String(nome).trim().split(/\s+/);
                      leadFirstName = parts[0];
                      if (parts.length > 1) leadLastName = parts[parts.length - 1];
                    }
                    const leadUserData = await buildUserData({
                      email: email && email.includes('@') ? email : undefined,
                      phone: telDigits || undefined,
                      first_name: leadFirstName || undefined,
                      last_name: leadLastName || undefined,
                      city: 'recife',
                      state: 'pe',
                      country: 'br',
                      external_id: email || telDigits || undefined,
                    });
                    // lead_id: Meta-generated 15-17 digit (validar formato defensivo)
                    if (/^\d{15,17}$/.test(String(leadId))) {
                      leadUserData.lead_id = String(leadId);
                    }
                    if (process.env.META_PAGE_ID) leadUserData.page_id = process.env.META_PAGE_ID;
                    const leadPayload = {
                      data: [{
                        event_name: 'Lead',
                        event_time: Math.floor(Date.now() / 1000),
                        event_id: `leadgen_${leadId}`,
                        action_source: 'system_generated',
                        user_data: leadUserData,
                        custom_data: {
                          event_source: 'crm',
                          lead_event_source: 'Chatwoot',
                          leadgen_form_id: String(formId || ''),
                          ...(adId ? { ad_id: String(adId) } : {}),
                          content_name: 'Meta Lead Ad Form Submission',
                          content_category: 'depilacao_laser',
                          currency: 'BRL',
                          value: 0,
                          customer_segmentation: 'new_customer_to_business',
                        },
                      }],
                      partner_agent: PARTNER_AGENT,
                    };
                    const leadResp = await fetch(`${GRAPH_BASE}/${PIXEL_ID}/events`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${CAPI_TOKEN}`,
                      },
                      body: JSON.stringify(leadPayload),
                    });
                    const leadJson = await leadResp.json();
                    if (leadJson.error) {
                      console.error(`[LEADGEN CAPI] ⚠️ Rejected: code=${leadJson.error.code} subcode=${leadJson.error.error_subcode} msg=${leadJson.error.message} lead_id=${leadId}`);
                      // Fix 23/04/2026: persist em Blob alerts pra cron capi-alerts detectar.
                      // Silent reject no Pixel LP seria invisivel pro wizard Conversion Leads.
                      try {
                        if (process.env.BLOB_READ_WRITE_TOKEN) {
                          const alertKey = `alerts/capi-errors/${Date.now()}-${leadJson.error.error_subcode || leadJson.error.code || 'unknown'}-${Math.random().toString(36).slice(2, 8)}.json`;
                          await put(alertKey, JSON.stringify({
                            at: new Date().toISOString(),
                            source: 'pixel_lp_leadgen_handler',
                            pixel_id: PIXEL_ID,
                            event_name: 'Lead',
                            event_id: `leadgen_${leadId}`,
                            lead_id: String(leadId),
                            action_source: 'system_generated',
                            error_code: leadJson.error.code,
                            error_subcode: leadJson.error.error_subcode,
                            error_type: leadJson.error.type,
                            error_message: leadJson.error.message,
                            fbtrace_id: leadJson.fbtrace_id,
                          }), {
                            access: 'public', addRandomSuffix: false,
                            contentType: 'application/json', cacheControlMaxAge: 0,
                          });
                        }
                      } catch { /* alert persist não pode quebrar handler */ }
                    } else {
                      const received = leadJson.events_received ?? 0;
                      if (Array.isArray(leadJson.messages) && leadJson.messages.length > 0) {
                        console.warn(`[CAPI WARN LEADGEN] received=${received} messages=${JSON.stringify(leadJson.messages)} fbtrace=${leadJson.fbtrace_id}`);
                      }
                      if (received === 0) {
                        console.error(`[LEADGEN CAPI SILENT_DROP] received=0 fbtrace=${leadJson.fbtrace_id || 'n/a'} lead_id=${leadId}`);
                      }
                      console.log(`[LEADGEN CAPI] ✅ Lead event fired: lead_id=${leadId} received=${received}`);
                    }

                    // Fix 21/04/2026: FAN-OUT WAM dataset. Antes só Pixel principal.
                    // sendWAMEvent helper decide skipar se não tem ctwa_clid+page_id
                    // (WAM requer business_messaging action_source).
                    try {
                      const wamResp = await sendWAMEvent({
                        event_name: 'Lead',
                        event_id: `leadgen_${leadId}`,
                        event_time: Math.floor(Date.now() / 1000),
                        user_data: { ...leadUserData },
                        custom_data: {
                          event_source: 'crm',
                          lead_event_source: 'Chatwoot',
                          leadgen_form_id: String(formId || ''),
                          ...(adId ? { ad_id: String(adId) } : {}),
                          content_name: 'Meta Lead Ad Form Submission',
                          content_category: 'depilacao_laser',
                          currency: 'BRL',
                          value: 0,
                          customer_segmentation: 'new_customer_to_business',
                        },
                      });
                      if (wamResp?.skipped) console.log(`[WAM LEADGEN] skipped: ${wamResp.skipped}`);
                      else if (wamResp?.error) console.warn(`[WAM LEADGEN] error: ${wamResp.error.message}`);
                      else console.log(`[WAM LEADGEN] ✅ received=${wamResp?.events_received}`);
                    } catch (wamErr) {
                      console.error('[WAM LEADGEN] exception:', wamErr.message);
                    }
                  } catch (capiErr) {
                    console.error('[LEADGEN CAPI] exception:', capiErr.message);
                  }
                }
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
        // Fix HIGH 19/04/2026: `continue` pra permitir Meta batch múltiplas entries.
        continue;
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
            // Fix HIGH AI audit 20/04/2026: passar wamid pra event_id idempotente.
            await processarLeadFlow(from, msg.interactive.nfm_reply, ctwaClid, msg.id);
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
    //
    // Fix HIGH AI review 19/04/2026: URLs Railway removidas do fallback hardcoded
    // (expõe infra interna). Agora lê SOMENTE de env vars. Se não configurado, skip forward
    // (graceful degradation) + backup Blob preserva payload pra recovery manual.
    const CHATWOOT_WA_WEBHOOK = process.env.CHATWOOT_WEBHOOK_URL;
    if (!CHATWOOT_WA_WEBHOOK) {
      console.warn('[WEBHOOK] ⚠️ CHATWOOT_WEBHOOK_URL not configured — skipping forward');
    }

    const MEDIA_TYPES = ['audio', 'video', 'image', 'document', 'sticker'];
    const MEDIA_LABELS = { audio: '🎤 Áudio', video: '🎬 Vídeo', image: '📷 Imagem', document: '📄 Documento', sticker: '🏷️ Sticker' };

    // Fix LOW AI review 20/04/2026 (L5): forwardToEvolution removido.
    // Função nunca chamada (Evolution API desabilitada desde 17/04/2026).
    // Código morto aumentava superfície de manutenção. Reativação futura:
    // reimplementar em branch separado com lookup do commit pré-remoção.

    const sendToChat = async (payload, label = 'original') => {
      if (!CHATWOOT_WA_WEBHOOK) {
        console.warn(`[CHATWOOT] ${label}: skip (CHATWOOT_WEBHOOK_URL not configured)`);
        return { ok: false, status: 503 };
      }
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
          // Fix MEDIUM AI review 20/04/2026 (M7): paralelizar downloadMediaToBlob.
          // Antes fazia N*3 fetches sequenciais (Graph metadata + download + put)
          // dentro do for loop. Com 3 imagens = 9 ops sequenciais. Em payload com
          // vídeos grandes, facilmente estourava timeout 30s Vercel Function.
          // Promise.allSettled: se 1 mídia falhar, outras ainda são entregues.
          const payload = JSON.parse(JSON.stringify(body));
          const mediaJobs = [];
          for (const entry of payload.entry || []) {
            for (const change of entry.changes || []) {
              const msgs = change.value?.messages || [];
              for (let i = 0; i < msgs.length; i++) {
                const msg = msgs[i];
                if (MEDIA_TYPES.includes(msg.type)) {
                  mediaJobs.push({ msgs, i, msg });
                }
              }
            }
          }
          const blobUrls = await Promise.allSettled(
            mediaJobs.map(job => downloadMediaToBlob(job.msg))
          );
          for (let j = 0; j < mediaJobs.length; j++) {
            const { msgs, i, msg } = mediaJobs[j];
            const blobUrl = blobUrls[j].status === 'fulfilled' ? blobUrls[j].value : null;
            const label = MEDIA_LABELS[msg.type] || msg.type;
            const caption = msg[msg.type]?.caption || '';
            const blobLink = blobUrl ? `\n🔗 ${blobUrl}` : '';
            msgs[i] = { from: msg.from, id: msg.id, timestamp: msg.timestamp, type: 'text',
              text: { body: `${label} recebido${caption ? ': ' + caption : ''}${blobLink}` } };
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

    // Fix 21/04/2026 v2 (AI Gateway review): backupBlob MOVIDO pra cá.
    // dedupMark salva OK dentro do loop; backupBlob no início ficava órfão.
    // Agora executa junto com outras async ops, imediatamente antes do res.
    await backupBlob();

    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
