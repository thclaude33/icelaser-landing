/**
 * /api/kommo-webhook — Kommo CRM webhook handler (JP-only).
 *
 * Recebe Integration Webhooks Kommo (32 events configurados em webhook 47250067)
 * e dispara Meta CAPI pro Pixel JP `1386967056530127`.
 *
 * Multi-tenant: Recife continua via crm-webhook.js (Chatwoot). JP usa este handler.
 * Não há WAM dataset pra JP (chip dedicado pendente).
 *
 * STAGES JP → Eventos Meta (status_lead, dedup-safe via TRANSITION key):
 *   105176167 "Lead Frio"             → Lead
 *   105176171 "Lead Qualificado"      → QualifiedLead (custom)
 *   105176175 "Avaliação Agendada"    → Schedule
 *   105176179 "Avaliação Comparecida" → CompleteRegistration
 *   105176183 "Pré-venda"             → InitiateCheckout
 *   142       "Closed - won"          → Purchase (lead.price ou CF_PURCHASE_VALUE)
 *   143       "Closed - lost"         → LeadDesqualificado (custom)
 *   105176163 "Incoming Leads"        → IGNORADO (espera transition pra Lead Frio)
 *
 * ARQUITETURA: cobre 100% do funil JP. Kommo CAPI nativo NÃO usado (depende de
 * IG conectado à Page; IG @espacoicelaser está no business do gestor anterior).
 *
 * Auth: header `X-Kommo-Token` validar contra KOMMO_WEBHOOK_SECRET (env var).
 * FAIL-CLOSED em produção (NODE_ENV=production sem secret = rejeita).
 *
 * Code review v2 aplicado 2026-04-29 — 15 issues corrigidos:
 *   ROUND 1 (issues do review inicial):
 *     #1 event_id stable
 *     #2 pipeline_id check em status_lead
 *     #3 city/state hardcoded removido
 *     #4 action_source dinâmico (business_messaging/system_generated)
 *     #5 external_id email > phone (dedup com Pixel browser)
 *     #6 event_source_url = LP domain
 *     #7 auth fail-closed prod
 *     #8 getContact lógica simplificada
 *   ROUND 2 (achados pós-memory-refresh — bugs críticos do round 1):
 *     N#1 event_id REALMENTE estável via TRANSITION KEY (payload Kommo não tem updated_at)
 *     N#2 add_lead deduped via STAGE_TO_META_EVENT (evita 2x Lead duplicate)
 *     N#3 account_id validado em body.account (não em cada lead)
 *     N#4 page_id JP no user_data (EMQ boost Meta 2026)
 *     N#5 import crypto removido (dead code pós-SDK)
 *     N#6 JSDoc realinhado com implementação
 *     N#7 CF_PURCHASE_VALUE usado pra Purchase value (fallback robusto)
 */

import { sendCapiEvents, filterValidEvents } from './_lib/capi.js';
import { buildUserData as sdkBuildUserData } from './_lib/piiBuilder.js';
import { PIXEL_ID_JPA, PAGE_ID_JPA } from './_lib/config.js';

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

// Kommo stage IDs → Meta event mapping. STAGES IGNORADOS:
//   - 105176163 "Incoming Leads" (type=1 system) — espera transition pra Lead Frio
//   - Qualquer pipeline NÃO 13628687 (filtered antes do mapping)
const STAGE_TO_META_EVENT = {
  '105176167': 'Lead',                  // Lead Frio
  '105176171': 'QualifiedLead',         // Lead Qualificado (custom event)
  '105176175': 'Schedule',              // Avaliação Agendada
  '105176179': 'CompleteRegistration',  // Avaliação Comparecida
  '105176183': 'InitiateCheckout',      // Pré-venda
  '142':       'Purchase',              // Closed - won (system stage Kommo)
  '143':       'LeadDesqualificado',    // Closed - lost (custom event)
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
  // DEBUG temporário: log URL completa + headers Kommo
  console.log(`[KOMMO-WEBHOOK-DEBUG] method=${req.method} url=${req.url} ` +
    `host=${req.headers.host} ua=${(req.headers['user-agent'] || '').slice(0,80)} ` +
    `ct=${req.headers['content-type']} ` +
    `has_query_token=${!!req.query?.token} ` +
    `has_header_token=${!!req.headers['x-kommo-token']}`);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!authorize(req)) {
    return res.status(401).json({ error: 'unauthorized', debug: 'check_query_token_or_header' });
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
  const result = await sendCapiEvents(validEvents, token, { pixelId: PIXEL_ID_JPA });

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
