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
 * Code review v3 aplicado 2026-05-02:
 *   - Mapping atualizado pra novos stages (105357711 LEAD FRIO + 105329767 LINK PAGAMENTO)
 *   - Removido stage 105176183 (não existe mais no pipeline atual)
 *   - Removido Lead/QL/CR mappings (WAM já dispara, evita inflação)
 *   - Removido Purchase mapping (Kommo native CAPI já dispara, evita duplo-count)
 *   - Destination dataset: Bancarios-EventData (1694874711857319) — dedicado JPA CAPI
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

// Custom field IDs JP (criados via API 28/04 — vide reference_kommo_jp_complete §1)
const CF_CTWA_CLID = 3815860;
const CF_META_AD_ID = 3815864;
const CF_WHATSAPP_PHONE = 3815868;   // text type (criado por nós, não multitext nativo)
const CF_PURCHASE_VALUE = 3815870;   // numeric (fallback pra lead.price)
// CF_LEAD_ID_FACEBOOK=3815862, CF_META_CAMPAIGN_NAME=3815866, CF_SERVICO_INTERESSE=3815872
// (declared pra futuro custom_data enrichment)

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
  let email, phone, ctwaClid, hasMetaAdId, purchaseValueCustom;
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
    // Custom JP fields
    if (Number(id) === CF_WHATSAPP_PHONE && !phone) phone = String(val);
    if (Number(id) === CF_CTWA_CLID && val) ctwaClid = String(val);
    if (Number(id) === CF_META_AD_ID && val) hasMetaAdId = true;
    if (Number(id) === CF_PURCHASE_VALUE) {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) purchaseValueCustom = n;
    }
  }
  return { email, phone, ctwaClid, hasMetaAdId, purchaseValueCustom };
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
function buildLeadEvent({ leadId, eventName, dedupKey, lead, userData, ctwaClid, hasMetaAdId, customData = {} }) {
  // event_time = lead.updated_at se vier (algumas variantes Kommo populam),
  // senão now. NÃO usado pra dedup (event_id é o dedup key real).
  const eventTimeSec = Number(lead?.updated_at) || Number(lead?.modified_at) ||
                       Number(lead?.created_at) || Math.floor(Date.now() / 1000);

  // action_source dinâmico (FIX #4):
  //   - business_messaging quando lead vem de Click-to-Message ad (CTWA_CLID/META_AD_ID populados)
  //     → Andromeda dá boost de atribuição em CTWA campaigns
  //   - system_generated pra leads CRM-driven (manual/import/form)
  const isCtwa = Boolean(ctwaClid || hasMetaAdId);
  const actionSource = isCtwa ? 'business_messaging' : 'system_generated';

  const event = {
    event_name: eventName,
    event_time: eventTimeSec,
    // FIX N#1: event_id IDEMPOTENTE — TRANSITION KEY garante mesma string em retry
    event_id: `kommo_jp_${leadId}_${eventName}_${dedupKey}`,
    action_source: actionSource,
    // FIX #6: domain LP verificado (não Kommo CRM)
    event_source_url: `${LP_DOMAIN_JP}/jp`,
    user_data: userData,
    custom_data: {
      lead_event_source: 'Kommo',
      event_source: 'crm',
      ...customData,
    },
  };
  // business_messaging requer messaging_channel (filterValidEvents valida — error 2804063 sem ele)
  if (actionSource === 'business_messaging') {
    event.messaging_channel = 'whatsapp';
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!authorize(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Kommo Integration Webhooks payload é x-www-form-urlencoded com keys
  // tipo `leads[add][0][id]=...` e `account[id]=...` — Vercel body-parser
  // (qs lib) decodifica em estrutura `{ leads: { add: [{ id: '...' }] }, account: { id: '...' } }`.
  // JSON puro também funciona (algumas integrações enviam assim).
  const body = req.body || {};

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
  // FIX N#2: SÓ dispara se stage atual mapeia pra evento Meta. Caso contrário
  // (ex: stage=incoming 105176163), espera transition status_lead. Evita
  // 2x Lead duplicate (incoming via add_lead + Lead Frio via status_lead).
  for (const lead of leadsAdd) {
    if (lead.pipeline_id && String(lead.pipeline_id) !== KOMMO_PIPELINE_JP) continue;
    const stageId = String(lead.status_id || '');
    const eventName = STAGE_TO_META_EVENT[stageId];
    if (!eventName) continue; // incoming → espera transition

    const contact = await getContact(lead.id, lead._embedded?.contacts);
    if (!contact) {
      errors.push({ lead: lead.id, reason: 'no_contact', event: 'add_lead', stage: stageId });
      continue;
    }
    const pii = extractContactPII(contact, lead);
    const userData = await buildUserDataKommo(contact, pii);

    const customData = {};
    if (eventName === 'Purchase') {
      customData.currency = 'BRL';
      const priceNum = Number(lead.price);
      const valFromLead = Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null;
      // FIX N#7: fallback CF_PURCHASE_VALUE custom field se lead.price ausente
      customData.value = valFromLead || pii.purchaseValueCustom || 497;
    }

    events.push(buildLeadEvent({
      leadId: lead.id,
      eventName,
      // FIX N#1: dedup key idempotente — add em stage X é único por lead+stage
      dedupKey: `add_${stageId}`,
      lead,
      userData,
      ctwaClid: pii.ctwaClid,
      hasMetaAdId: pii.hasMetaAdId,
      customData,
    }));
  }

  // === STATUS_LEAD: lead mudou de stage ===
  for (const lead of leadsStatus) {
    if (lead.pipeline_id && String(lead.pipeline_id) !== KOMMO_PIPELINE_JP) continue;

    const newStatusId = String(lead.status_id || '');
    const oldStatusId = String(lead.old_status_id || 'init');
    const eventName = STAGE_TO_META_EVENT[newStatusId];
    if (!eventName) continue; // stage irrelevante (ex: voltar pra incoming)

    const contact = await getContact(lead.id, lead._embedded?.contacts);
    if (!contact) {
      errors.push({ lead: lead.id, reason: 'no_contact', stage: newStatusId, event: eventName });
      continue;
    }
    const pii = extractContactPII(contact, lead);
    const userData = await buildUserDataKommo(contact, pii);

    const customData = {};
    if (eventName === 'Purchase') {
      customData.currency = 'BRL';
      const priceNum = Number(lead.price);
      const valFromLead = Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null;
      customData.value = valFromLead || pii.purchaseValueCustom || 497;
    }

    events.push(buildLeadEvent({
      leadId: lead.id,
      eventName,
      // FIX N#1: dedup key = transition única (old → new). Retry 4x = mesmo event_id.
      dedupKey: `${oldStatusId}_to_${newStatusId}`,
      lead,
      userData,
      ctwaClid: pii.ctwaClid,
      hasMetaAdId: pii.hasMetaAdId,
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
