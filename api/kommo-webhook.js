/**
 * /api/kommo-webhook — Kommo CRM webhook handler (JP-only).
 *
 * Recebe eventos do Kommo (add_lead, status_lead, etc) e dispara Meta CAPI
 * pro Pixel JP (1386967056530127). Multi-tenant: Recife continua via
 * crm-webhook.js (Chatwoot) — JP usa este novo handler.
 *
 * Eventos mapeados (Kommo → Meta CAPI):
 *   add_lead        → Lead
 *   status_lead     → Status-specific event:
 *     "Lead Qualificado"      → QualifiedLead
 *     "Avaliação Agendada"    → Schedule
 *     "Avaliação Comparecida" → CompleteRegistration
 *     "Pré-venda"             → InitiateCheckout
 *     "Closed - won"          → Purchase
 *     "Closed - lost"         → LeadDesqualificado (custom)
 *
 * Pixel JP: 1386967056530127 (separado de Recife 2774496306216737)
 * NÃO usa WAM dataset (JP não tem chip dedicado WAM ainda).
 *
 * Auth: header `X-Kommo-Token` validar contra KOMMO_WEBHOOK_SECRET (env var).
 *
 * Memory: project_kommo_jp_setup_2026_04_28.md (a criar)
 */

import crypto from 'node:crypto';
import { sendCapiEvents } from './_lib/capi.js';
import { PIXEL_ID_JPA } from './_lib/config.js';

const KOMMO_ACCOUNT_ID = '36397911';
const KOMMO_PIPELINE_JP = '13628687';
const KOMMO_SUBDOMAIN = 'thiagosml';

// Kommo stage IDs → Meta event mapping
//
// IMPORTANTE: Kommo CAPI NATIVO cobre Lead (Lead Frio) e Purchase (Closed-won)
// com valor do Budget field. Removidos daqui pra EVITAR DUPLICATE de events
// no Meta Events Manager. Mantidos apenas os eventos do meio do funil que
// Kommo nativo não suporta (QualifiedLead, Schedule, CompleteRegistration,
// InitiateCheckout, LeadDesqualificado).
//
// Se quiser desabilitar este webhook custom completamente e usar APENAS Kommo
// nativo, vide README + setting do webhook (disabled: true).
const STAGE_TO_META_EVENT = {
  // '105176167': 'Lead',                  // Lead Frio — DEIXA Kommo nativo
  '105176171': 'QualifiedLead',         // Lead Qualificado
  '105176175': 'Schedule',              // Avaliação Agendada
  '105176179': 'CompleteRegistration',  // Avaliação Comparecida
  '105176183': 'InitiateCheckout',      // Pré-venda
  // '142':       'Purchase',              // Closed - won — DEIXA Kommo nativo (com Budget)
  '143':       'LeadDesqualificado',    // Closed - lost (custom event)
};

function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function normalizePhone(raw) {
  if (!raw) return undefined;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return undefined;
  return digits.startsWith('55') ? digits : `55${digits}`;
}

function buildUserData(contact) {
  const ud = {};
  const customFields = contact?.custom_fields_values || contact?.custom_fields || [];
  for (const f of customFields) {
    const code = f.field_code || f.code;
    const val = f.values?.[0]?.value;
    if (!val) continue;
    if (code === 'PHONE' || code === 'WHATSAPP_PHONE') ud.ph = sha256(normalizePhone(val));
    if (code === 'EMAIL') ud.em = sha256(val);
  }
  if (contact?.name) {
    const parts = String(contact.name).trim().split(/\s+/);
    if (parts[0]) ud.fn = sha256(parts[0]);
    if (parts.length > 1) ud.ln = sha256(parts.slice(1).join(' '));
  }
  if (contact?.id) ud.external_id = sha256(`kommo_jp_${contact.id}`);
  ud.country = sha256('br');
  ud.ct = sha256('joao pessoa');
  ud.st = sha256('pb');
  return ud;
}

function buildLeadEvent({ leadId, eventName, contact, customData = {} }) {
  return {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: `kommo_jp_${leadId}_${eventName}_${Date.now()}`,
    action_source: 'system_generated',
    event_source_url: `https://${KOMMO_SUBDOMAIN}.kommo.com/leads/detail/${leadId}`,
    user_data: buildUserData(contact),
    custom_data: {
      lead_event_source: 'Kommo',
      event_source: 'crm',
      ...customData,
    },
  };
}

function authorize(req) {
  const expected = process.env.KOMMO_WEBHOOK_SECRET;
  if (!expected) return true; // dev mode (sem secret = aceita)
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

  const body = req.body || {};
  const events = [];
  const errors = [];

  // Kommo envia em batch: { leads: { add: [...], status: [...] }, contacts: { add: [...] } }
  const leadsAdd = body.leads?.add || [];
  const leadsStatus = body.leads?.status || [];
  const contactsCache = new Map();

  async function getContact(leadId, contactsList) {
    if (contactsList && contactsList[0]) {
      const cid = contactsList[0].id;
      if (contactsCache.has(cid)) return contactsCache.get(cid);
      const data = await fetchKommoEntity(`/contacts/${cid}`);
      contactsCache.set(cid, data);
      return data;
    }
    // fallback: pega lead full c/ contacts embedded
    const leadFull = await fetchKommoEntity(`/leads/${leadId}?with=contacts`);
    return leadFull?._embedded?.contacts?.[0] || null;
  }

  for (const lead of leadsAdd) {
    if (lead.account_id && String(lead.account_id) !== KOMMO_ACCOUNT_ID) continue;
    const contact = await getContact(lead.id, lead.custom_fields_values && lead._embedded?.contacts);
    if (!contact) {
      errors.push({ lead: lead.id, reason: 'no_contact' });
      continue;
    }
    events.push(buildLeadEvent({ leadId: lead.id, eventName: 'Lead', contact }));
  }

  for (const lead of leadsStatus) {
    if (lead.account_id && String(lead.account_id) !== KOMMO_ACCOUNT_ID) continue;
    const newStatusId = String(lead.status_id);
    const eventName = STAGE_TO_META_EVENT[newStatusId];
    if (!eventName) continue; // status irrelevante
    const contact = await getContact(lead.id, null);
    if (!contact) {
      errors.push({ lead: lead.id, reason: 'no_contact', stage: newStatusId });
      continue;
    }
    const customData = {};
    if (eventName === 'Purchase') {
      customData.currency = 'BRL';
      customData.value = lead.price || 497;
    }
    events.push(buildLeadEvent({ leadId: lead.id, eventName, contact, customData }));
  }

  if (events.length === 0) {
    return res.status(200).json({ ok: true, processed: 0, errors });
  }

  // Disparar pro Pixel JP
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'meta_token_missing' });
  }
  const result = await sendCapiEvents(events, token, { pixelId: PIXEL_ID_JPA });

  console.log(`[KOMMO-JP] processed=${events.length} | meta=${JSON.stringify(result).slice(0, 200)}`);
  return res.status(200).json({ ok: true, processed: events.length, meta: result, errors });
}
