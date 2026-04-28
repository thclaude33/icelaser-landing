/**
 * WhatsApp Marketing Message Event Sharing dataset helper.
 *
 * Dataset ID específico (diferente do pixel principal) pra atribuição de
 * conversões originadas de CTWA ads (Click-to-WhatsApp). Meta usa esses
 * eventos pra otimizar campanhas de mensagens WhatsApp e atribuir
 * corretamente quando user clica ad → conversa → converte.
 *
 * REQUISITOS ESTRITOS (Meta spec WAM Event Sharing v25 - validado LIVE 27/04/2026):
 *   - event_name VÁLIDO em action_source=business_messaging (10 events, Meta v25):
 *       LeadSubmitted, QualifiedLead, Purchase, InitiateCheckout, AddToCart,
 *       ViewContent, OrderCreated, CartAbandoned, RatingProvided, ReviewProvided
 *     Lista canônica: const BUSINESS_MESSAGING_VALID (linha ~101 deste arquivo).
 *     Helper `sendWAMEvent` faz fallback automático business_messaging→system_generated
 *     quando event_name não está nessa whitelist (preserva ctwa_clid → atribuição
 *     via Meta lookback 7d). NÃO listar Shipped/Delivered/Canceled/Returned/Schedule/
 *     Contact aqui — REJEITADOS por Meta v25 com subcode 2804066 (testado LIVE).
 *   - action_source: "business_messaging" OU "system_generated" (fallback)
 *   - messaging_channel: "whatsapp" (apenas em business_messaging)
 *   - user_data.page_id (OBRIGATÓRIO em business_messaging)
 *   - user_data.ctwa_clid (REAL, Meta-gerado no click CTWA, ≥32 chars) OU
 *     user_data.page_scoped_user_id (PSID)
 *
 * Sem ctwa_clid/PSID em business_messaging → Meta rejeita com erro 2804071.
 * Com ctwa_clid fake/inválido (<32 chars) → Meta rejeita com erro 2804087.
 *
 * Pipeline: rodar EM PARALELO com CAPI normal (pixel principal) quando
 * ctwa_clid disponível. Dedup natural via event_id idêntico.
 */

import { put } from '@vercel/blob';
import { PARTNER_AGENT } from './capi.js';
import { GRAPH_BASE } from './config.js';

const WAM_DATASET_ID = process.env.WAM_DATASET_ID;
// Fix HIGH (AI review C3): SEM fallback. Token errado → atribuição cross-dataset
// silenciosa (compliance-breaking). Se WAM_ACCESS_TOKEN ausente → skip explícito.
const WAM_TOKEN = process.env.WAM_ACCESS_TOKEN;
// Fix HIGH (AI review): sem fallback hardcoded — atribuição cruzada em prod é compliance-breaking.
const PAGE_ID = process.env.META_PAGE_ID;
const WABA_ID = process.env.META_WABA_ID;

// Fix MEDIUM (AI review): Meta ctwa_clid reais são longos (40+ chars).
// Threshold 8 permitia clids fake que eram rejeitados com subcode 2804087 —
// melhor early-skip pra não desperdiçar API call.
const MIN_CTWA_CLID_LENGTH = 32;
const MIN_PSID_LENGTH = 6;
const FETCH_TIMEOUT_MS = 10000;
const MAX_EVENT_AGE_SECONDS = 7 * 24 * 3600; // Meta rejeita events > 7 dias

// Issue 6 (PR follow-up /review 38): rate-limit console.warn pra evitar log spam
// em alta volume. Janela 60s, dedup por bucket key (ex: 'auto_convert_lead',
// 'fallback_<eventName>'). Vercel Drain conta runtime logs storage → poluição
// = custo extra. Tamanho map limitado a 100 entries (LRU-ish via cleanup).
const WARN_DEDUP_WINDOW_MS = 60_000;
const WARN_DEDUP_MAX_KEYS = 100;
const _warnLastEmittedAt = new Map();
function warnRateLimited(message, bucketKey) {
  const now = Date.now();
  const last = _warnLastEmittedAt.get(bucketKey);
  if (last !== undefined && now - last < WARN_DEDUP_WINDOW_MS) {
    return; // suprime — já logou esse bucket nos últimos 60s
  }
  _warnLastEmittedAt.set(bucketKey, now);
  // Cleanup defensivo: se mapa cresceu além do limite, remove entries antigas.
  if (_warnLastEmittedAt.size > WARN_DEDUP_MAX_KEYS) {
    for (const [k, ts] of _warnLastEmittedAt) {
      if (now - ts > WARN_DEDUP_WINDOW_MS) _warnLastEmittedAt.delete(k);
    }
  }
  console.warn(message);
}

// Meta WAM Dataset event whitelist — events ACEITOS pelo dataset em
// ao menos UM action_source (business_messaging OU system_generated).
//
// IMPORTANTE: este set é mais AMPLO que `BUSINESS_MESSAGING_VALID` (definido
// dentro de sendWAMEvent). Events como 'CompleteRegistration', 'Subscribe',
// 'Qualified Lead' (espaço) NÃO funcionam em business_messaging (rejeição
// silenciosa subcode 2804066) MAS funcionam em system_generated (validado
// LIVE 27/04/2026 — TEST2 events_received=1 contra dataset 967048725669499).
//
// O helper sendWAMEvent faz fallback automático business_messaging→system_generated
// quando event_name não está em BUSINESS_MESSAGING_VALID, preservando ctwa_clid
// em user_data pra atribuição via Meta lookback 7d.
//
// EXPORTADA pra track.js usar como gate antes do fan-out (evitar API calls
// pra events que o dataset rejeita em todas action_sources, ex: PageView).
export const WAM_ALLOWED_EVENTS = new Set([
  'Purchase',
  'Lead',
  'LeadSubmitted',
  'QualifiedLead',     // legacy camelCase (pre-2026-04-26 events)
  'Qualified Lead',    // FIX 2026-04-26: Meta Conversion Leads CRM funil exige
                       // o nome COM ESPAÇO. Validado LIVE: Meta trata
                       // 'QualifiedLead' e 'Qualified Lead' como events SEPARADOS.
                       // Funnel Conversion Leads usa o com espaço.
  'CompleteRegistration',
  'Subscribe',
  'InitiateCheckout',
  'AddToCart',
  'AddPaymentInfo',
  'ViewContent',
  'OrderCreated',
  'Shipped',
  'Delivered',
  'Canceled',
  'Returned',
  'CartAbandoned',
  'RatingProvided',
  'ReviewProvided',
]);

// Whitelist OFICIAL Meta v25 — events VÁLIDOS em action_source=business_messaging.
// Validado LIVE Graph API 27/04/2026 (23 testes diretos contra dataset
// 967048725669499 com test_event_code TEST27042026_FIX_VALIDATION).
//
// ✅ ACEITOS em business_messaging (subcode 2804087 = ctwa inválido, event OK):
//   LeadSubmitted, QualifiedLead (camelCase), Purchase, InitiateCheckout,
//   AddToCart, ViewContent, OrderCreated, CartAbandoned, RatingProvided,
//   ReviewProvided
// ❌ REJEITADOS em business_messaging (subcode 2804066, mas OK system_generated):
//   Lead (auto-convert→LeadSubmitted), CompleteRegistration, 'Qualified Lead'
//   (com espaço, mantido pra Conversion Leads CRM funnel), Subscribe,
//   AddPaymentInfo, Shipped, Delivered, Canceled, Returned, Schedule, Contact,
//   LeadDesqualificado (custom)
//
// Memory: feedback_meta_v25_business_messaging_event_whitelist.md
const BUSINESS_MESSAGING_VALID = new Set([
  'LeadSubmitted', 'QualifiedLead',
  'Purchase', 'InitiateCheckout', 'AddToCart', 'ViewContent',
  'OrderCreated', 'CartAbandoned',
  'RatingProvided', 'ReviewProvided',
]);

/**
 * Envia evento pro WAM dataset.
 * @param {object} opts
 * @param {string} opts.event_name - Meta standard event name (whitelisted)
 * @param {string} opts.event_id - dedup key OBRIGATÓRIO (cross-dataset dedup)
 * @param {number} [opts.event_time] - unix seconds (default: now)
 * @param {object} opts.user_data - DEVE ter ctwa_clid OU page_scoped_user_id
 * @param {object} [opts.custom_data] - Purchase exige currency + value
 * @returns {Promise<object>} resposta Meta ou { skipped: 'reason' }
 */
export async function sendWAMEvent({ event_name, event_id, event_time, user_data, custom_data, action_source, original_event_data }) {
  if (!WAM_DATASET_ID) return { skipped: 'wam_dataset_not_configured' };
  if (!WAM_TOKEN) return { skipped: 'wam_token_missing' };
  // Issue 5 defensive (PR follow-up /review 38): trim defensivo evita whitespace
  // bypass nas comparações strict-equal abaixo (ex: 'Lead ' não fazia auto-convert
  // pra LeadSubmitted). Case NÃO normalizado: Meta v25 é case-sensitive ('lead'
  // ≠ 'Lead') e silenciar isso esconderia bugs reais de caller.
  const normalizedEventName = typeof event_name === 'string' ? event_name.trim() : '';
  if (!normalizedEventName || !WAM_ALLOWED_EVENTS.has(normalizedEventName)) {
    return { skipped: `wam_event_not_supported: ${event_name}` };
  }
  // Fix HIGH (AI review): event_id obrigatório pra dedup. Sem ele, Meta conta
  // duplicatas quando cron retry dispara o mesmo evento (quebra métricas).
  if (!event_id || typeof event_id !== 'string' || event_id.length < 8) {
    return { skipped: 'wam_event_id_required_for_dedup' };
  }
  // Fix HIGH (AI review): Purchase sem currency+value é aceito mas atribui
  // revenue=0 → quebra otimização de campanhas ROAS.
  if (normalizedEventName === 'Purchase') {
    if (!custom_data?.currency || custom_data?.value === undefined || custom_data?.value === null) {
      return { skipped: 'wam_purchase_requires_currency_and_value' };
    }
  }
  // Fix HIGH (AI review C4): Meta rejeita event_time > 7 dias. Cron retries
  // antigos consomem quota sem efeito. Skip early.
  const finalEventTime = event_time || Math.floor(Date.now() / 1000);
  const age = Math.floor(Date.now() / 1000) - finalEventTime;
  if (age > MAX_EVENT_AGE_SECONDS) {
    return { skipped: `wam_event_too_old: ${age}s > 7d` };
  }
  const ud = user_data || {};
  const hasCtwa = typeof ud.ctwa_clid === 'string' && ud.ctwa_clid.length >= MIN_CTWA_CLID_LENGTH;
  const hasPsid = typeof ud.page_scoped_user_id === 'string' && ud.page_scoped_user_id.length >= MIN_PSID_LENGTH;
  // FIX 27/04/2026 — Decisão action_source baseada em whitelist Meta v25.
  // BUSINESS_MESSAGING_VALID está em module scope (linha ~85) — VALIDADO LIVE.
  // Fallback system_generated quando event_name não suportado em BM:
  //   subcode 2804066 = event_name NÃO permitido em business_messaging
  //   → fallback preserva ctwa_clid em user_data pra atribuição via Meta lookback 7d
  //   → validado LIVE: system_generated + ctwa_clid no WAM dataset → events_received=1

  // Caller intenta business_messaging?
  //   - explícito: passou action_source='business_messaging' (ex: crm-webhook routingDecision)
  //   - implícito: deixou undefined + ctwa/psid presente (ex: whatsapp.js, process-leadgen)
  // Issue 3 (PR follow-up /review 38): normaliza action_source pra trim+lowercase
  // antes da comparação. Caller passar 'BUSINESS_MESSAGING' ou ' business_messaging '
  // antes resultava em fallback silencioso pra system_generated. Meta API espera
  // valor exato lowercase — se passou variação aqui, normalizamos pra consistência.
  const normalizedActionSource = typeof action_source === 'string'
    ? action_source.trim().toLowerCase()
    : '';
  const callerExplicitBM = normalizedActionSource === 'business_messaging';
  const callerImplicitBM = !normalizedActionSource && (hasCtwa || hasPsid);
  const callerIntendsBM = callerExplicitBM || callerImplicitBM;

  // Auto-convert Lead → LeadSubmitted ANTES da decisão action_source.
  // Lead é alias canônico de LeadSubmitted no messaging context (Meta v25).
  // Aplicar SEMPRE que caller intenta business_messaging preserva atribuição
  // CTWA pra callers legacy (whatsapp.js:1462, process-leadgen.js:317) que
  // passam event_name='Lead' sem action_source explícito.
  // Issue 5 (PR follow-up /review 38): usa normalizedEventName (trimmed) pra
  // capturar 'Lead ' ou ' Lead' sem bypass silencioso.
  let finalEventName = normalizedEventName;
  if (callerIntendsBM && finalEventName === 'Lead') {
    finalEventName = 'LeadSubmitted';
    warnRateLimited(`[WAM] Auto-convert Lead→LeadSubmitted (business_messaging spec Meta v25). event_id=${event_id}`, 'auto_convert_lead');
  }

  // Decisão action_source:
  //   1. Caller forçou system_generated explícito → respeita
  //   2. Intenção BM + event_name válido na whitelist → business_messaging
  //   3. Intenção BM + event_name NÃO válido → fallback system_generated
  //      (ctwa_clid permanece em user_data → atribuição via Meta lookback 7d)
  //   4. Sem intenção BM (sem ctwa/psid, sem explicit) → system_generated
  let finalActionSource;
  if (normalizedActionSource && normalizedActionSource !== 'business_messaging') {
    // Issue 3: caller forçou action_source explícito (ex: 'system_generated',
    // 'website') → usa valor normalizado (lowercase) pra Meta aceitar.
    finalActionSource = normalizedActionSource;
  } else if (callerIntendsBM && BUSINESS_MESSAGING_VALID.has(finalEventName)) {
    finalActionSource = 'business_messaging';
  } else if (callerIntendsBM) {
    warnRateLimited(
      `[WAM] event_name='${finalEventName}' não suportado em business_messaging (Meta v25 rejeita 2804066). Fallback action_source=system_generated. event_id=${event_id}`,
      `fallback_${finalEventName}`
    );
    finalActionSource = 'system_generated';
  } else {
    finalActionSource = 'system_generated';
  }
  const isBusinessMessaging = finalActionSource === 'business_messaging';

  if (isBusinessMessaging && !hasCtwa && !hasPsid) {
    return { skipped: 'wam_business_messaging_requires_ctwa_clid_or_psid' };
  }
  // Fix HIGH (AI review C2): page_id obrigatório em business_messaging
  // (Meta rejeita 2804116). Skip early se env ausente.
  if (isBusinessMessaging && !PAGE_ID && !ud.page_id) {
    return { skipped: 'wam_business_messaging_requires_page_id' };
  }
  // Qualquer action_source exige PELO MENOS UMA matching key.
  const hasMatchingKey = !!(
    ud.em || ud.ph || ud.external_id || ud.fbp || ud.fbc ||
    (ud.fn && ud.ln) || ud.ctwa_clid || ud.page_scoped_user_id
  );
  if (!hasMatchingKey) {
    return { skipped: 'wam_requires_matching_key' };
  }
  // (auto-convert Lead → LeadSubmitted já aplicado acima, antes da decisão action_source)
  const enrichedUserData = { ...ud };
  // page_id é obrigatório em business_messaging; opcional mas helpful em outros.
  if (PAGE_ID && !enrichedUserData.page_id) {
    enrichedUserData.page_id = PAGE_ID;
  }
  // Fix CRITICAL (23/04/2026 LIVE Graph API reproduction): Meta v25 REJEITA
  // `fbc`, `fbp`, `client_ip_address`, `client_user_agent` em user_data quando
  // action_source=business_messaging. Subcode 2804064 com error_user_msg:
  //   "Remova todos os argumentos inválidos para os eventos LeadSubmitted com
  //    a fonte da ação business_messaging: fbc [ou fbp, ou client_ip_address
  //    client_user_agent]."
  // Validado LIVE com 4 testes isolados (T3/T7/T8) contra WAM Dataset
  // 967048725669499 às 14:11 UTC 23/04/2026. Callers (whatsapp.js:250,705 e
  // crm-webhook.js:1096) espalham userData completo — strip defensivo aqui
  // evita atribuição CTWA silenciosamente perdida (erro no Blob alerts).
  // NOTA: esses campos são VÁLIDOS em website/system_generated — só banidos
  // em business_messaging. Pixel LP CTWA LeadSubmitted (whatsapp.js:615) já
  // envia fbc corretamente pro PIXEL_ID com action_source=business_messaging,
  // mas Meta aceita porque PIXEL é website dataset. WAM é messaging-only.
  if (isBusinessMessaging) {
    delete enrichedUserData.fbc;
    delete enrichedUserData.fbp;
    delete enrichedUserData.client_ip_address;
    delete enrichedUserData.client_user_agent;
  }
  // Fix C-2 (22/04/2026 audit): WABA_ID REMOVIDO — Meta v25 REJEITA
  // `whatsapp_business_account_id` em user_data quando presente com ctwa_clid —
  // retorna OAuthException code=1 "An unknown error has occurred". Confirma via
  // memory feedback_meta_capi_waba_id_rejected.md (18/04) + LIVE WAM 24h=0
  // LeadSubmitted vs Pixel LP=11 (attribution CTWA zerada). NÃO reintroduzir.
  const eventObj = {
    event_name: finalEventName,
    event_time: finalEventTime,
    event_id,
    action_source: finalActionSource,
    user_data: enrichedUserData,
    // Fix MEDIUM (AI review M3): omitir custom_data vazio (Meta documenta).
    ...(custom_data && Object.keys(custom_data).length > 0 ? { custom_data } : {}),
    // Fix 22/04/2026 (WAM diagnostic "server events not deduplicated"):
    // Linka Lead/CR/IC CRM subsequentes ao Lead Pixel browser original via
    // original_event_data.event_id. Meta entende como "continuação" do Lead
    // original, não como duplicata. Resolve o diagnostico sem quebrar matching.
    // Ref: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/original-event/
    ...(original_event_data && typeof original_event_data === 'object' ? { original_event_data } : {}),
  };
  if (isBusinessMessaging) {
    eventObj.messaging_channel = 'whatsapp';
  }
  const payload = {
    data: [eventObj],
    partner_agent: PARTNER_AGENT,
  };
  try {
    // Fix MEDIUM (AI review): timeout defensivo — WAM é paralelo ao CAPI
    // principal, não pode segurar o handler request indefinidamente.
    const resp = await fetch(`${GRAPH_BASE}/${WAM_DATASET_ID}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WAM_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const rawText = await resp.text();
    let json;
    try {
      json = JSON.parse(rawText);
    } catch {
      // Meta pode retornar HTML em 5xx/503 Cloudflare maintenance
      console.error(`[WAM] non-JSON HTTP ${resp.status}: ${rawText.slice(0, 120)}`);
      return { error: { message: `WAM HTTP ${resp.status}`, wam_non_json: true } };
    }
    const ctwaTrunc = ud.ctwa_clid ? `${ud.ctwa_clid.slice(0, 12)}...` : 'none';
    if (json.error) {
      console.error(`[WAM] ⚠️ Rejected event=${event_name}→${finalEventName} code=${json.error.code} subcode=${json.error.error_subcode} msg=${json.error.message} ctwa=${ctwaTrunc} event_id=${event_id}`);
      // Fix VA-5 (23/04/2026 AI review): persist CAPI errors em Blob pra cron
      // capi-alerts.js processar e enviar email se count>0 na hora seguinte.
      // Antes, errors subcode 2804066/OAuthException ficavam dias em prod sem
      // detecção — só auditoria manual achou. Agora alerta automático.
      try {
        if (process.env.BLOB_READ_WRITE_TOKEN) {
          const alertKey = `alerts/capi-errors/${Date.now()}-${json.error.error_subcode || json.error.code || 'unknown'}-${Math.random().toString(36).slice(2, 8)}.json`;
          await put(alertKey, JSON.stringify({
            at: new Date().toISOString(),
            source: 'wam',
            dataset_id: WAM_DATASET_ID,
            event_name_requested: event_name,
            event_name_sent: finalEventName,
            event_id,
            action_source: finalActionSource,
            error_code: json.error.code,
            error_subcode: json.error.error_subcode,
            error_type: json.error.type,
            error_message: json.error.message,
            fbtrace_id: json.fbtrace_id,
            has_ctwa: !!ud.ctwa_clid,
            has_page_id: !!(ud.page_id || PAGE_ID),
          }), {
            access: 'public',
            contentType: 'application/json',
            allowOverwrite: false,
            cacheControlMaxAge: 0,
          });
        }
      } catch { /* alert persistence não pode quebrar o fluxo principal */ }
    } else {
      console.log(`[WAM] ✅ ${finalEventName} received=${json.events_received} trace=${json.fbtrace_id} event_id=${event_id} ctwa=${ctwaTrunc}`);
    }
    return json;
  } catch (e) {
    // AbortError no timeout / network errors
    console.error(`[WAM] exception: ${e.name || 'Error'}: ${e.message} event_id=${event_id}`);
    return { error: { message: e.message, wam_exception: true } };
  }
}

export function wamIsConfigured() {
  return !!(WAM_DATASET_ID && WAM_TOKEN);
}
