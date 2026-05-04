/**
 * /api/kommo-webhook — Kommo CRM webhook handler (JP-only).
 *
 * Recebe Integration Webhooks Kommo (47261059 — recriado 02/05 17:39 BRT após
 * equipe externa deletar o webhook anterior 47250587) e dispara Meta CAPI pro
 * dataset Bancarios-EventData `1694874711857319`.
 *
 * Multi-tenant: Recife continua via crm-webhook.js (Chatwoot). JP usa este handler.
 *
 * ESTRATÉGIA NÃO-CONFLITO (atualizado 02/05/2026 19:40 BRT):
 *   WAM Recife (967048725669499) já dispara Lead/QualifiedLead/CompleteRegistration
 *   pra subdomain jpa.icelasers.com.br via crm-webhook Chatwoot.
 *   Kommo NATIVE CAPI (integração marketplace Kommo↔Meta) dispara Lead+Purchase
 *   automaticamente via Meta Leads CRM infrastructure.
 *   Esta config aqui complementa SÓ events que NENHUM dos 2 cobre — zero overlap.
 *
 * PIPELINE 13628687 — 9 stages atuais (equipe externa reformulou em 01/05):
 *   105176163 "Incoming leads"           → IGNORADO (system, espera transition)
 *   105176167 "primeiro contato"         → IGNORADO (WAM + Kommo native dispara Lead)
 *   105357711 "LEAD FRIO"                → LeadFrio (custom — exclusivo Kommo CAPI) ⭐
 *   105176171 "Lead Qualificado"         → IGNORADO (WAM já dispara QualifiedLead)
 *   105329767 "LINK DE PAGAMENTO"        → InitiateCheckout (exclusivo) ⭐
 *   105176175 "Avaliação Agendada"       → Schedule (exclusivo)
 *   105176179 "Avaliação Comparecida"    → IGNORADO (WAM já dispara CR)
 *   142       "COMPRA REALIZADA"         → IGNORADO (Kommo native CAPI já dispara Purchase)
 *   143       "DESQUALIFICADO/PERDIDO"   → LeadDesqualificado (custom — exclusivo)
 *
 * Auth: header `X-Kommo-Token` ou ?token=... validar contra KOMMO_WEBHOOK_SECRET.
 * FAIL-CLOSED em produção (NODE_ENV=production sem secret = rejeita).
 *
 * Code review v4 aplicado 2026-05-03 — REFERRAL ENRICHMENT:
 *   - Custom field IDs RECRIADOS (3829010-3829022) — IDs antigos foram deletados
 *     pela equipe externa, bridge antes referenciava IDs zumbi → ctwa_clid sempre
 *     vazio → action_source caía pra system_generated → Andromeda CTWA boost perdido
 *   - enrichLeadFromReferral() roda em todo add_lead, busca metadata.origin via API,
 *     populates custom fields (ctwa_clid, ad_id, source_url, fbc, etc) via PATCH lead
 *   - buildLeadEvent agora aceita pii completo + injeta user_data.fbc + custom_data.ad_id
 *   - Graceful failure: enrich falhar não quebra dispatch CAPI
 *
 * Code review v3 aplicado 2026-05-02:
 *   - Mapping atualizado pra novos stages (105357711 LEAD FRIO + 105329767 LINK PAGAMENTO)
 *   - Removido stage 105176183 (não existe mais no pipeline atual)
 *   - Removido Lead/QL/CR mappings (WAM já dispara, evita inflação)
 *   - Removido Purchase mapping (Kommo native CAPI já dispara, evita duplo-count)
 *   - Destination dataset: Bancarios-EventData (1694874711857319) — dedicado JPA CAPI
 *   - v3.2: dedup intra-payload via Set seenLeadEvents (FIX edge case
 *     add_lead + status_lead pra mesmo lead/stage no mesmo payload)
 *
 * Code review v2 aplicado 2026-04-29 — 15 issues corrigidos:
 *   ROUND 1: event_id stable, pipeline_id check, city/state removido, action_source
 *     dinâmico, external_id email > phone, event_source_url LP, auth fail-closed,
 *     getContact lógica simplificada
 *   ROUND 2: event_id idempotente via TRANSITION KEY, add_lead deduped via mapping,
 *     account_id validado em body.account, page_id no user_data, import crypto
 *     removido, JSDoc realinhado, CF_PURCHASE_VALUE fallback
 */

import { sendCapiEvents, filterValidEvents } from './_lib/capi.js';
import { buildUserData as sdkBuildUserData } from './_lib/piiBuilder.js';
import { PAGE_ID_JPA, KOMMO_CAPI_DATASET } from './_lib/config.js';

const KOMMO_ACCOUNT_ID = '36397911';
const KOMMO_PIPELINE_JP = '13628687';
const KOMMO_SUBDOMAIN = 'thiagosml';

// Domain canônico LP JP (verificado no Meta). event_source_url usa este pra que
// Meta linke evento ao domain correto e não reduza EMQ por mismatch.
const LP_DOMAIN_JP = 'https://icelaser-landing.vercel.app';

// Custom field IDs JP — VERSÃO ATUAL (03/05/2026).
// Os IDs antigos (3815860/3815862/3815864/3815866/3815868/3815870) foram deletados
// pela equipe externa — recriei via API com IDs novos abaixo. Bridge anterior
// estava com IDs zumbi → ctwa_clid + ad_id sempre vinham vazios → action_source
// caía pra "system_generated" sempre, perdendo Andromeda CTWA boost.
const CF_CTWA_CLID         = 3829010;  // text — Meta WhatsApp Click ID
const CF_META_AD_ID        = 3829012;  // text — Meta ad_id (referral.source_id)
const CF_META_ADSET_ID     = 3829014;  // text
const CF_META_CAMPAIGN_ID  = 3829016;  // text
const CF_META_SOURCE_URL   = 3829018;  // text — referral.source_url
const CF_META_FBC          = 3829020;  // text — fb.1.{ts}.{ctwa_clid}
const CF_META_FBP          = 3829022;  // text — Pixel browser ID
// LEGACY (auto-criados pelo Kommo, mantidos):
const CF_FBCLID            = 3813890;  // tracking_data
const CF_UTM_SOURCE        = 3813878;
const CF_UTM_CAMPAIGN      = 3813876;
const CF_UTM_MEDIUM        = 3813874;
const CF_UTM_CONTENT       = 3813872;
const CF_REFERRER          = 3813884;
const CF_SERVICO_INTERESSE = 3815872;  // único survivor da leva 28/04

// Kommo stage → Meta event mapping (v3 — não-conflito com WAM + Kommo native CAPI).
// Pipeline JP 13628687, 9 stages (atualizado 01/05 pela equipe externa).
//
// Estratégia ZERO OVERLAP — 2 sources já disparando devem ser respeitadas:
//   - WAM Recife (967048725669499) já dispara: Lead, QualifiedLead, CompleteRegistration
//   - Kommo native CAPI (Meta Leads CRM integration) já dispara: Lead, Purchase
// Este handler complementa SÓ events que NENHUM dos 2 cobre.
//
// IGNORADOS (não disparam CAPI aqui):
//   - 105176163 "Incoming leads" (type=1 system stage)
//   - 105176167 "primeiro contato" (WAM + Kommo native cobrem Lead)
//   - 105176171 "Lead Qualificado" (WAM cobre QualifiedLead)
//   - 105176179 "Avaliação Comparecida" (WAM cobre CompleteRegistration)
//   - 142       "COMPRA REALIZADA" (Kommo native CAPI cobre Purchase)
//   - Qualquer pipeline diferente de 13628687
const STAGE_TO_META_EVENT = {
  '105357711': 'LeadFrio',              // LEAD FRIO (custom — exclusivo Kommo CAPI)
  '105329767': 'InitiateCheckout',      // LINK DE PAGAMENTO (exclusivo Kommo CAPI)
  '105176175': 'Schedule',              // Avaliação Agendada (exclusivo Kommo CAPI)
  '143':       'LeadDesqualificado',    // DESQUALIFICADO/PERDIDO (custom — exclusivo)
};

function normalizePhone(raw) {
  if (!raw) return undefined;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return undefined;
  return digits.startsWith('55') ? digits : `55${digits}`;
}

/**
 * Extrai PII de contact + lead.
 * Lê custom_fields_values (Kommo doc oficial §AA) — multitext PHONE/EMAIL com
 * enum_code (WORK/MOB/etc) ou text custom (WHATSAPP_PHONE 3815868).
 */
function extractContactPII(contact, lead) {
  let email, phone;
  let ctwaClid, adId, adsetId, campaignId, sourceUrl, fbc, fbp, fbclid;
  let utmSource, utmCampaign, utmMedium, utmContent, referrer;
  // FIX Vercel Agent #3: removido `purchaseValueCustom` (CF_PURCHASE_VALUE foi
  // deletado pela equipe externa em 03/05). Purchase events usam lead.price como
  // fonte canônica. Se lead.price ausente, fallback hardcoded 497 em buildLeadEvent.
  const fields = [
    ...(contact?.custom_fields_values || contact?.custom_fields || []),
    ...(lead?.custom_fields_values || lead?.custom_fields || []),
  ];
  for (const f of fields) {
    const code = f.field_code || f.code;
    const id = f.field_id || f.id;
    const val = f.values?.[0]?.value;
    if (val == null || val === '') continue;
    // PHONE/EMAIL nativos = multitext (Kommo doc §AA)
    if (code === 'PHONE' && !phone) phone = String(val);
    if (code === 'EMAIL' && !email) email = String(val);

    // Meta CTWA tracking fields (criados 03/05)
    if (Number(id) === CF_CTWA_CLID)        ctwaClid = String(val);
    if (Number(id) === CF_META_AD_ID)       adId = String(val);
    if (Number(id) === CF_META_ADSET_ID)    adsetId = String(val);
    if (Number(id) === CF_META_CAMPAIGN_ID) campaignId = String(val);
    if (Number(id) === CF_META_SOURCE_URL)  sourceUrl = String(val);
    if (Number(id) === CF_META_FBC)         fbc = String(val);
    if (Number(id) === CF_META_FBP)         fbp = String(val);

    // Tracking_data fields auto-criados (utm_*, fbclid)
    if (Number(id) === CF_FBCLID)        fbclid = String(val);
    if (Number(id) === CF_UTM_SOURCE)    utmSource = String(val);
    if (Number(id) === CF_UTM_CAMPAIGN)  utmCampaign = String(val);
    if (Number(id) === CF_UTM_MEDIUM)    utmMedium = String(val);
    if (Number(id) === CF_UTM_CONTENT)   utmContent = String(val);
    if (Number(id) === CF_REFERRER)      referrer = String(val);
  }
  // hasMetaAdId mantido como flag pra compat com buildLeadEvent
  const hasMetaAdId = Boolean(adId);
  return {
    email, phone,
    ctwaClid, adId, adsetId, campaignId, sourceUrl, fbc, fbp, fbclid,
    utmSource, utmCampaign, utmMedium, utmContent, referrer,
    hasMetaAdId,
  };
}

/**
 * Mergea pii base (do contact + lead payload) com enrichment recém-PATCHado.
 * FIX Vercel Agent #2 (race condition): enrichLeadFromReferral PATCH o lead via API
 * mas o `lead` passado pra extractContactPII vem do webhook payload original — sem
 * os fields recém-populados. Solução: enrich retorna os valores e a gente mergea
 * preferindo enrichValues (mais frescos) sobre pii original.
 */
function mergeEnrichmentIntoPII(pii, enrich) {
  if (!enrich || Object.keys(enrich).length === 0) return pii;
  const merged = { ...pii };
  // Enrich values têm prioridade — foram acabados de PATCHar
  if (enrich.ctwaClid    && !merged.ctwaClid)    merged.ctwaClid = enrich.ctwaClid;
  if (enrich.adId        && !merged.adId)        merged.adId = enrich.adId;
  if (enrich.adsetId     && !merged.adsetId)     merged.adsetId = enrich.adsetId;
  if (enrich.campaignId  && !merged.campaignId)  merged.campaignId = enrich.campaignId;
  if (enrich.sourceUrl   && !merged.sourceUrl)   merged.sourceUrl = enrich.sourceUrl;
  if (enrich.fbc         && !merged.fbc)         merged.fbc = enrich.fbc;
  if (enrich.utmSource   && !merged.utmSource)   merged.utmSource = enrich.utmSource;
  if (enrich.fbclid      && !merged.fbclid)      merged.fbclid = enrich.fbclid;
  // Recompute hasMetaAdId
  merged.hasMetaAdId = Boolean(merged.adId);
  return merged;
}

/**
 * FIX Vercel Agent #1: messaging_channel dinâmico baseado no source.
 * Meta CAPI accepted values: 'whatsapp', 'messenger', 'instagram_direct'.
 * Source name vem como `waba:{phone_id}`, `instagram_business:{ig_id}`,
 * `facebook:{page_id}` (Kommo padrão).
 */
function inferMessagingChannel(sourceName, utmSource) {
  const src = String(sourceName || '').toLowerCase();
  if (src.startsWith('waba:') || src.startsWith('whatsapp:')) return 'whatsapp';
  if (src.startsWith('instagram_business:') || src.startsWith('instagram:')) return 'instagram_direct';
  if (src.startsWith('facebook:') || src.startsWith('messenger:')) return 'messenger';
  // Fallback: usa utm_source se conhecido
  const u = String(utmSource || '').toLowerCase();
  if (u === 'whatsapp_ad' || u === 'whatsapp') return 'whatsapp';
  if (u === 'instagram') return 'instagram_direct';
  if (u === 'facebook') return 'messenger';
  return 'whatsapp'; // default seguro pra business_messaging (CTWA é o caso dominante)
}

function splitName(name) {
  if (!name) return { firstName: undefined, lastName: undefined };
  const parts = String(name).trim().split(/\s+/);
  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : undefined,
  };
}

/**
 * Build user_data via SDK piiBuilder (mesma normalização que track.js + crm-webhook.js).
 * - external_id = email > phone > kommo contact_id (dedup com Pixel browser site)
 * - city/state OMITIDOS (raio 3km JP inclui Cabedelo/Bayeux/Santa Rita; hardcoded prejudica EMQ)
 * - page_id JP adicionado pós-SDK (matching key high-priority Meta 2026)
 */
async function buildUserDataKommo(contact, pii) {
  const { firstName, lastName } = splitName(contact?.name);
  const phoneNormalized = normalizePhone(pii.phone);
  const emailLower = pii.email ? String(pii.email).toLowerCase().trim() : undefined;
  const externalIdRaw = emailLower || phoneNormalized || (contact?.id ? `kommo_jp_${contact.id}` : undefined);
  return sdkBuildUserData({
    email: emailLower,
    phone: phoneNormalized,
    first_name: firstName,
    last_name: lastName,
    country: 'br',
    external_id: externalIdRaw,
    // FIX N#4: page_id JP nativo do SDK (piiBuilder.js linha 271 — não-hashed,
    // matching key high-priority Meta CAPI 2026 → EMQ boost CTWA campaigns)
    page_id: PAGE_ID_JPA,
  });
}

/**
 * Build CAPI event com event_id IDEMPOTENTE (FIX N#1).
 * Kommo retry 4x em 1h se webhook não responder <2s. event_id baseado em
 * TRANSITION KEYS (não timestamp) garante Meta dedup em retentativas.
 *
 * @param dedupKey  string única por evento lógico (ex: "add_105176167" ou "incoming_to_frio")
 */
function buildLeadEvent({ leadId, eventName, dedupKey, lead, userData, pii, customData = {} }) {
  // event_time = lead.updated_at se vier (algumas variantes Kommo populam),
  // senão now. NÃO usado pra dedup (event_id é o dedup key real).
  const eventTimeSec = Number(lead?.updated_at) || Number(lead?.modified_at) ||
                       Number(lead?.created_at) || Math.floor(Date.now() / 1000);

  // action_source dinâmico (FIX #4):
  //   - business_messaging quando lead vem de Click-to-Message ad (CTWA_CLID/META_AD_ID populados)
  //     → Andromeda dá boost de atribuição em CTWA campaigns
  //   - system_generated pra leads CRM-driven (manual/import/form)
  const isCtwa = Boolean(pii?.ctwaClid || pii?.hasMetaAdId);
  const actionSource = isCtwa ? 'business_messaging' : 'system_generated';

  // FIX 03/05 v4: enrichment user_data.fbc + custom_data.ad_id pra atribuição CAPI.
  // user_data.fbc no formato oficial Meta CAPI: fb.1.{ts_ms}.{ctwa_clid}
  // (https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters)
  // sem isso, Meta atribui evento mas NÃO conecta ao ad CTWA original — Andromeda
  // não otimiza CTWA campaigns sem fbc.
  const enrichedUserData = { ...userData };
  if (pii?.fbc) {
    enrichedUserData.fbc = pii.fbc;
  } else if (pii?.ctwaClid) {
    enrichedUserData.fbc = `fb.1.${eventTimeSec * 1000}.${pii.ctwaClid}`;
  }
  if (pii?.fbp) enrichedUserData.fbp = pii.fbp;
  if (pii?.fbclid && !enrichedUserData.fbc) {
    // fallback fbclid (browser-side click) caso ctwa_clid ausente mas fbclid populado
    enrichedUserData.fbc = `fb.1.${eventTimeSec * 1000}.${pii.fbclid}`;
  }

  // custom_data enriquecido com ad attribution
  const enrichedCustomData = {
    lead_event_source: 'Kommo',
    event_source: 'crm',
    ...customData,
  };
  if (pii?.adId)        enrichedCustomData.ad_id = pii.adId;
  if (pii?.adsetId)     enrichedCustomData.adset_id = pii.adsetId;
  if (pii?.campaignId)  enrichedCustomData.campaign_id = pii.campaignId;
  if (pii?.utmSource)   enrichedCustomData.utm_source = pii.utmSource;
  if (pii?.utmCampaign) enrichedCustomData.utm_campaign = pii.utmCampaign;
  if (pii?.utmMedium)   enrichedCustomData.utm_medium = pii.utmMedium;
  if (pii?.utmContent)  enrichedCustomData.utm_content = pii.utmContent;

  const event = {
    event_name: eventName,
    event_time: eventTimeSec,
    // FIX N#1: event_id IDEMPOTENTE — TRANSITION KEY garante mesma string em retry
    event_id: `kommo_jp_${leadId}_${eventName}_${dedupKey}`,
    action_source: actionSource,
    // FIX #6: domain LP verificado (não Kommo CRM)
    event_source_url: pii?.sourceUrl || `${LP_DOMAIN_JP}/jp`,
    user_data: enrichedUserData,
    custom_data: enrichedCustomData,
  };
  // business_messaging requer messaging_channel (filterValidEvents valida — error 2804063 sem ele)
  // FIX Vercel Agent #1: dinâmico baseado em source — antes era hardcoded 'whatsapp'
  // causando misattribution em leads Instagram/Facebook.
  if (actionSource === 'business_messaging') {
    event.messaging_channel = inferMessagingChannel(pii?.sourceName, pii?.utmSource);
  }
  return event;
}

/**
 * FIX #7: auth fail-CLOSED em produção (sem secret = rejeita).
 * Em dev (NODE_ENV != production), aceita pra testes locais.
 */
function authorize(req) {
  const expected = process.env.KOMMO_WEBHOOK_SECRET;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') return false; // fail-closed
    return true; // dev mode
  }
  const provided = req.headers['x-kommo-token'] || req.query?.token;
  return provided === expected;
}

/**
 * FIX 02/05/2026: Vercel body-parser default NÃO decodifica bracket-notation
 * form-urlencoded. Kommo envia `leads[status][0][id]=X` que vira flat key string.
 * Reconstrói nested object pra `{ leads: { status: [{ id: X }] } }`.
 *
 * Detecta JSON nested (já parseado) e retorna direto.
 * Suporta arrays via numeric brackets (`[0]`, `[1]`) e objects via string keys.
 *
 * @param {Record<string, unknown>} rawBody - body do Vercel parser (flat ou nested)
 * @returns {Record<string, unknown>} body normalizado nested
 */
function parseKommoBody(rawBody) {
  if (!rawBody || typeof rawBody !== 'object') return {};
  // Se já é nested (JSON puro), retorna direto
  if (rawBody.leads && typeof rawBody.leads === 'object' && !Array.isArray(rawBody.leads)) {
    return rawBody;
  }
  // Heurística: se nenhuma key tem `[`, body já está nested (caso edge)
  const hasBrackets = Object.keys(rawBody).some(k => k.includes('['));
  if (!hasBrackets) return rawBody;

  const result = {};
  for (const [flatKey, value] of Object.entries(rawBody)) {
    // "leads[status][0][id]" → ['leads', 'status', '0', 'id']
    const parts = flatKey.match(/[^\[\]]+/g);
    if (!parts || parts.length === 0) continue;
    let cursor = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const nextPart = parts[i + 1];
      const nextIsIndex = /^\d+$/.test(nextPart);
      if (cursor[part] === undefined) {
        cursor[part] = nextIsIndex ? [] : {};
      }
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
  }
  return result;
}

async function fetchKommoEntity(path) {
  const token = process.env.KOMMO_TOKEN_JP;
  if (!token) return null;
  try {
    const r = await fetch(`https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function patchKommoLead(leadId, customFields) {
  const token = process.env.KOMMO_TOKEN_JP;
  if (!token || !customFields?.length) return null;
  try {
    const r = await fetch(`https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads/${leadId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ custom_fields_values: customFields }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.warn(`[KOMMO-JP] PATCH lead ${leadId} failed: ${r.status} ${body.slice(0, 200)}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.warn(`[KOMMO-JP] PATCH lead ${leadId} error: ${e?.message}`);
    return null;
  }
}

/**
 * FIX 03/05 v4: Captura metadata.referral do WABA payload e popula custom fields.
 *
 * Quando lead chega via CTWA, Meta envia metadata em `messages[0].referral` com:
 *   source_id (= ad_id), source_type, source_url, ctwa_clid, headline, body
 * Kommo recebe esse payload via integration WhatsApp Cloud API e armazena em
 * `unsorted.metadata.origin` (campos disponíveis: chat_id, ref, visitor_uid).
 *
 * Estratégia:
 *   1. Busca unsorted matching o lead → /leads/unsorted?filter[lead_id]={id}
 *   2. Extrai metadata.origin (ctwa_clid pode vir em ref OU visitor_uid)
 *   3. PATCH lead com custom_fields_values populados
 *   4. Eventos CAPI subsequentes (Frio/IC/Schedule) puxam fields populados
 *      → user_data.fbc + custom_data.ad_id corretos → atribuição precisa Meta
 *
 * Graceful failure: se algum step falhar, retorna {} sem throw — bridge continua
 * disparando CAPI com os dados que tem (degrada como hoje, sem regressão).
 *
 * @returns {Promise<{ctwaClid?: string, adId?: string, sourceUrl?: string}>}
 */
async function enrichLeadFromReferral(leadId) {
  if (!leadId) return {};
  // 🚨 BUG KOMMO API CONFIRMADO 03/05 — `filter[lead_id]` e `filter[entity_id]`
  // são SILENTLY IGNORED pelo /leads/unsorted endpoint. API sempre retorna
  // lista geral por created_at desc. Testado live com 5 valores diferentes
  // (incluindo lead inexistente 99999999) → todos retornam mesmo result set.
  //
  // Workaround: pega N unsorted recentes, filtra client-side por
  // `_embedded.leads[].id === leadId`. limit=20 cobre caso onde lead novo
  // chega + 19 outros leads chegando concorrentemente (extremo).
  const numericLeadId = Number(leadId);
  if (!Number.isFinite(numericLeadId)) return {};
  const params = new URLSearchParams();
  params.set('limit', '20');
  params.set('order[created_at]', 'desc');
  const unsortedList = await fetchKommoEntity(`/leads/unsorted?${params.toString()}`);
  const items = unsortedList?._embedded?.unsorted || [];
  if (items.length === 0) return {};

  // Client-side filter — encontrar o unsorted que tem este leadId em _embedded.leads
  const u = items.find(item =>
    item._embedded?.leads?.some(l => Number(l.id) === numericLeadId)
  );
  if (!u) {
    // Lead não veio via WABA/unsorted (criado via API/import/manual)
    console.log(`[KOMMO-JP] enrich lead=${leadId} no_unsorted_match (origem direta — sem CTWA referral disponível)`);
    return {};
  }
  const meta = u.metadata || {};
  const origin = meta.origin || {};
  const sourceName = u.source_name || meta.source_name || '';

  // Captura via metadata.origin (Kommo armazena ref + visitor_uid + chat_id aqui).
  // Em CTWA WABA, Meta passa source_id e ctwa_clid no welcome message.
  // Kommo NÃO mapeia 1:1 atualmente — visitor_uid pode ser ctwa_clid em alguns casos.
  // Como fallback, source_name "waba:..." indica origem WhatsApp Business.
  const ctwaClid = origin.ctwa_clid || origin.ref || null;
  const adId = meta.referral?.source_id || origin.source_id || null;
  const adsetId = meta.referral?.adset_id || null;
  const campaignId = meta.referral?.campaign_id || null;
  const sourceUrl = meta.referral?.source_url || null;
  const fbclid = meta.referral?.fbclid || null;

  // Determina utm_source baseado em source_name
  let utmSource;
  if (sourceName.startsWith('waba:')) utmSource = 'whatsapp_ad';
  else if (sourceName.startsWith('instagram_business:')) utmSource = 'instagram';
  else if (sourceName.startsWith('facebook:')) utmSource = 'facebook';

  // Constrói fbc no formato Meta CAPI se temos ctwa_clid
  const tsMs = (Number(u.created_at) || Math.floor(Date.now() / 1000)) * 1000;
  const fbc = ctwaClid ? `fb.1.${tsMs}.${ctwaClid}` : null;

  // Monta payload PATCH só com fields que temos valor
  const fields = [];
  const push = (id, value) => {
    if (value != null && value !== '') {
      fields.push({ field_id: id, values: [{ value: String(value) }] });
    }
  };
  push(CF_CTWA_CLID,         ctwaClid);
  push(CF_META_AD_ID,        adId);
  push(CF_META_ADSET_ID,     adsetId);
  push(CF_META_CAMPAIGN_ID,  campaignId);
  push(CF_META_SOURCE_URL,   sourceUrl);
  push(CF_META_FBC,          fbc);
  if (utmSource) push(CF_UTM_SOURCE, utmSource);
  if (fbclid)    push(CF_FBCLID, fbclid);

  if (fields.length === 0) {
    // Sem dados úteis no metadata — registra que tentou (origem orgânica/sem CTWA)
    console.log(`[KOMMO-JP] enrich lead=${leadId} source=${sourceName} no_referral_data`);
    return {};
  }

  await patchKommoLead(leadId, fields);
  console.log(
    `[KOMMO-JP] enriched lead=${leadId} source=${sourceName} ` +
    `fields=${fields.map(f => f.field_id).join(',')}`
  );
  return { ctwaClid, adId, adsetId, campaignId, sourceUrl, fbc, utmSource, fbclid, sourceName };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!authorize(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Kommo Integration Webhooks payload é x-www-form-urlencoded com keys tipo
  // `leads[add][0][id]=...` e `account[id]=...`. Vercel body-parser default NÃO
  // decodifica brackets, então parseKommoBody reconstrói o nested object.
  // JSON puro (algumas integrações) é detectado e retornado direto.
  const body = parseKommoBody(req.body || {});

  // FIX N#3: account_id em body.account.id (top-level), NÃO em cada lead.
  // Single account JP (36397911) — rejeita se diferente.
  const incomingAccountId = body.account?.id ?? body.account_id;
  if (incomingAccountId && String(incomingAccountId) !== KOMMO_ACCOUNT_ID) {
    return res.status(200).json({ ok: true, ignored_account: incomingAccountId });
  }

  const events = [];
  const errors = [];

  const leadsAdd = body.leads?.add || [];
  const leadsStatus = body.leads?.status || body.leads?.status_lead || [];
  const contactsCache = new Map();

  // FIX v3.2 (02/05/2026): dedup intra-payload (leadId + eventName).
  // Edge case: Kommo pode enviar add_lead + status_lead no mesmo payload
  // pra mesmo lead (lead criado já em stage não-default via API/Salesbot/import).
  // Sem este Set: 2 events disparados com event_ids diferentes (`add_${stageId}`
  // vs `${oldStatus}_to_${newStatus}`) → Meta NÃO dedupa → 2x conversion count.
  // Set garante 1 fire por (leadId, eventName) por payload. Status_lead é
  // processado DEPOIS de add_lead (ordem atual), então add_lead vence em conflito
  // — ambos têm event_id estável pra retry, then Meta dedupa nas retentativas.
  const seenLeadEvents = new Set();
  function alreadyFiredInPayload(leadId, eventName) {
    const key = `${leadId}_${eventName}`;
    if (seenLeadEvents.has(key)) return true;
    seenLeadEvents.add(key);
    return false;
  }

  async function getContact(leadId, embeddedContacts) {
    // FIX #8: passa _embedded.contacts direto se existir (sem `&&` confuso)
    if (embeddedContacts && embeddedContacts[0]) {
      const cid = embeddedContacts[0].id;
      if (contactsCache.has(cid)) return contactsCache.get(cid);
      const data = await fetchKommoEntity(`/contacts/${cid}`);
      contactsCache.set(cid, data);
      return data;
    }
    // Fallback: pega lead full c/ contacts embedded
    const leadFull = await fetchKommoEntity(`/leads/${leadId}?with=contacts`);
    return leadFull?._embedded?.contacts?.[0] || null;
  }

  // === ADD_LEAD: lead criado ===
  // FIX 03/05 v4: enrichLeadFromReferral roda PRA TODO add_lead (não só os com
  // stage mapeado), pra garantir que custom fields ctwa_clid/ad_id/fbc são
  // populados ASSIM que lead chega — antes de qualquer transition pra Frio/IC.
  // Eventos CAPI subsequentes (status_lead → Frio/IC/Schedule) puxam fields já
  // populados via extractContactPII → user_data.fbc + custom_data.ad_id corretos.
  for (const lead of leadsAdd) {
    if (lead.pipeline_id && String(lead.pipeline_id) !== KOMMO_PIPELINE_JP) continue;

    // FIX Vercel Agent #2 (race condition): enrich retorna os valores que populou.
    // Pii do lead original (webhook payload) NÃO tem fields recém-PATCHados ainda
    // (o lead full re-fetch seria 1 round-trip extra). Mergeamos enrich into pii
    // ao invés. Falha graciosa: se enrich fail, retorna {} e segue fluxo normal.
    const enrich = await enrichLeadFromReferral(lead.id).catch(() => ({}));

    const stageId = String(lead.status_id || '');
    const eventName = STAGE_TO_META_EVENT[stageId];
    if (!eventName) continue; // incoming → espera transition
    if (alreadyFiredInPayload(lead.id, eventName)) continue; // FIX v3.2

    const contact = await getContact(lead.id, lead._embedded?.contacts);
    if (!contact) {
      errors.push({ lead: lead.id, reason: 'no_contact', event: 'add_lead', stage: stageId });
      continue;
    }
    const piiBase = extractContactPII(contact, lead);
    const pii = mergeEnrichmentIntoPII(piiBase, enrich);
    const userData = await buildUserDataKommo(contact, pii);

    const customData = {};
    if (eventName === 'Purchase') {
      customData.currency = 'BRL';
      const priceNum = Number(lead.price);
      const valFromLead = Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null;
      // FIX Vercel Agent #3: removido pii.purchaseValueCustom (CF foi deletado).
      // Fallback hardcoded 497 (valor médio serviço IceLaser).
      customData.value = valFromLead || 497;
    }

    events.push(buildLeadEvent({
      leadId: lead.id,
      eventName,
      // FIX N#1: dedup key idempotente — add em stage X é único por lead+stage
      dedupKey: `add_${stageId}`,
      lead,
      userData,
      pii,
      customData,
    }));
  }

  // === STATUS_LEAD: lead mudou de stage ===
  // Note: enrich não roda aqui — em status_lead o lead já existe há tempo,
  // os custom fields já foram populados em add_lead anterior. extractContactPII
  // pega os values populated diretamente do lead (sem race condition).
  for (const lead of leadsStatus) {
    if (lead.pipeline_id && String(lead.pipeline_id) !== KOMMO_PIPELINE_JP) continue;

    const newStatusId = String(lead.status_id || '');
    const oldStatusId = String(lead.old_status_id || 'init');
    const eventName = STAGE_TO_META_EVENT[newStatusId];
    if (!eventName) continue; // stage irrelevante (ex: voltar pra incoming)
    if (alreadyFiredInPayload(lead.id, eventName)) continue; // FIX v3.2

    const contact = await getContact(lead.id, lead._embedded?.contacts);
    if (!contact) {
      errors.push({ lead: lead.id, reason: 'no_contact', stage: newStatusId, event: eventName });
      continue;
    }
    // status_lead webhook payload tem lead minimal (id, status_id, old_status_id) —
    // refetch lead full pra pegar custom_fields_values populated em add_lead anterior.
    const leadFull = await fetchKommoEntity(`/leads/${lead.id}`);
    const leadForPII = leadFull || lead;
    const pii = extractContactPII(contact, leadForPII);
    const userData = await buildUserDataKommo(contact, pii);

    const customData = {};
    if (eventName === 'Purchase') {
      customData.currency = 'BRL';
      const priceNum = Number(lead.price);
      const valFromLead = Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null;
      // FIX Vercel Agent #3: hardcoded 497 fallback (CF_PURCHASE_VALUE deletado)
      customData.value = valFromLead || 497;
    }

    events.push(buildLeadEvent({
      leadId: lead.id,
      eventName,
      // FIX N#1: dedup key = transition única (old → new). Retry 4x = mesmo event_id.
      dedupKey: `${oldStatusId}_to_${newStatusId}`,
      lead,
      userData,
      pii,
      customData,
    }));
  }

  if (events.length === 0) {
    return res.status(200).json({ ok: true, processed: 0, errors });
  }

  // Validação Meta CAPI (filterValidEvents do _lib/capi.js):
  //   - rejeita events sem event_name/event_time/action_source/user_data
  //   - rejeita business_messaging sem messaging_channel (error 2804063)
  //   - rejeita custom_data.value não-number ou currency não-ISO
  //   - clamp event_time pra janela 7d Meta (evita 2804003)
  const validEvents = filterValidEvents(events);
  if (validEvents.length === 0) {
    console.warn(`[KOMMO-JP] todos os ${events.length} events rejeitados em filterValidEvents`);
    return res.status(200).json({ ok: true, processed: 0, errors, dropped: events.length });
  }

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'meta_token_missing' });
  }
  const result = await sendCapiEvents(validEvents, token, { pixelId: KOMMO_CAPI_DATASET });

  console.log(
    `[KOMMO-JP] processed=${validEvents.length}/${events.length} ` +
    `events=${validEvents.map(e => e.event_name).join(',')} ` +
    `meta=${JSON.stringify(result).slice(0, 200)}`
  );
  return res.status(200).json({
    ok: true,
    processed: validEvents.length,
    dropped: events.length - validEvents.length,
    meta: result,
    errors,
  });
}
