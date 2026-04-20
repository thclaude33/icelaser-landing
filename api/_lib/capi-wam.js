/**
 * WhatsApp Marketing Message Event Sharing dataset helper.
 *
 * Dataset ID específico (diferente do pixel principal) pra atribuição de
 * conversões originadas de CTWA ads (Click-to-WhatsApp). Meta usa esses
 * eventos pra otimizar campanhas de mensagens WhatsApp e atribuir
 * corretamente quando user clica ad → conversa → converte.
 *
 * REQUISITOS ESTRITOS (Meta spec WAM Event Sharing):
 *   - event_name: APENAS padrão Meta (Purchase, LeadSubmitted, Lead,
 *     CompleteRegistration, Subscribe, InitiateCheckout)
 *   - action_source: "business_messaging"
 *   - messaging_channel: "whatsapp"
 *   - user_data.page_id (OBRIGATÓRIO)
 *   - user_data.ctwa_clid (REAL, Meta-gerado no click CTWA) OU
 *     user_data.page_scoped_user_id (PSID)
 *
 * Sem ctwa_clid/PSID → Meta rejeita com erro 2804071.
 * Com ctwa_clid fake/inválido → Meta rejeita com erro 2804087.
 *
 * Pipeline: rodar EM PARALELO com CAPI normal (pixel principal) quando
 * ctwa_clid disponível. Dedup natural via event_id idêntico.
 */

import { PARTNER_AGENT } from './capi.js';
import { GRAPH_BASE } from './config.js';

const WAM_DATASET_ID = process.env.WAM_DATASET_ID;
const WAM_TOKEN = process.env.CAPI_DATASET_TOKEN;
const PAGE_ID = process.env.META_PAGE_ID || '111790301665816';
const WABA_ID = process.env.META_WABA_ID;

const WAM_ALLOWED_EVENTS = new Set([
  'Purchase',
  'LeadSubmitted',
  'Lead',
  'CompleteRegistration',
  'Subscribe',
  'InitiateCheckout',
  'AddPaymentInfo',
  'Contact',
]);

/**
 * Envia evento pro WAM dataset.
 * @param {object} opts
 * @param {string} opts.event_name - Meta standard event name
 * @param {string} opts.event_id - dedup key (igualar ao CAPI principal p/ dedup cross-dataset)
 * @param {number} [opts.event_time] - unix seconds (default: now)
 * @param {object} opts.user_data - DEVE ter ctwa_clid OU page_scoped_user_id
 * @param {object} [opts.custom_data]
 * @returns {Promise<object>} resposta Meta ou { skipped: 'reason' }
 */
export async function sendWAMEvent({ event_name, event_id, event_time, user_data, custom_data }) {
  if (!WAM_DATASET_ID) return { skipped: 'wam_dataset_not_configured' };
  if (!WAM_TOKEN) return { skipped: 'wam_token_missing' };
  if (!event_name || !WAM_ALLOWED_EVENTS.has(event_name)) {
    return { skipped: `wam_event_not_supported: ${event_name}` };
  }
  const ud = user_data || {};
  const hasCtwa = typeof ud.ctwa_clid === 'string' && ud.ctwa_clid.length >= 8;
  const hasPsid = typeof ud.page_scoped_user_id === 'string' && ud.page_scoped_user_id.length >= 3;
  if (!hasCtwa && !hasPsid) {
    return { skipped: 'wam_requires_ctwa_clid_or_page_scoped_user_id' };
  }
  const enrichedUserData = {
    ...ud,
    page_id: ud.page_id || PAGE_ID,
  };
  if (WABA_ID && !enrichedUserData.whatsapp_business_account_id) {
    enrichedUserData.whatsapp_business_account_id = WABA_ID;
  }
  const payload = {
    data: [{
      event_name,
      event_time: event_time || Math.floor(Date.now() / 1000),
      event_id,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: enrichedUserData,
      custom_data: custom_data || {},
    }],
    partner_agent: PARTNER_AGENT,
  };
  try {
    const resp = await fetch(`${GRAPH_BASE}/${WAM_DATASET_ID}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WAM_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const json = await resp.json();
    if (json.error) {
      console.error(`[WAM] ⚠️ Rejected event_name=${event_name} code=${json.error.code} subcode=${json.error.error_subcode} msg=${json.error.message}`);
    } else {
      console.log(`[WAM] ✅ ${event_name} received=${json.events_received} trace=${json.fbtrace_id} event_id=${event_id}`);
    }
    return json;
  } catch (e) {
    console.error(`[WAM] exception: ${e.message}`);
    return { error: { message: e.message, wam_exception: true } };
  }
}

export function wamIsConfigured() {
  return !!(WAM_DATASET_ID && WAM_TOKEN);
}
