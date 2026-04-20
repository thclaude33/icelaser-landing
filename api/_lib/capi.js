/**
 * Cliente CAPI compartilhado.
 * - Usa Authorization: Bearer (não expõe token na URL)
 * - Retry automático em erros transientes
 * - Monitora rate limit headers (X-App-Usage, X-Business-Use-Case-Usage)
 */

import { GRAPH_BASE, PIXEL_ID } from './config.js';

const RATE_LIMIT_THRESHOLD = 80; // alerta a 80% de uso

// Meta best practice (docs oficiais 2026): incluir partner_agent pra identificar plataforma.
// Restrições Meta: <23 chars, >=2 letras. Enviado no payload top-level (não em cada event).
export const PARTNER_AGENT = 'icelaser-vercel';

function monitorRateLimit(res) {
  const appUsage = res.headers.get('x-app-usage');
  if (appUsage) {
    try {
      const u = JSON.parse(appUsage);
      if (
        u.call_count > RATE_LIMIT_THRESHOLD ||
        u.total_cputime > RATE_LIMIT_THRESHOLD ||
        u.total_time > RATE_LIMIT_THRESHOLD
      ) {
        console.warn(
          `[CAPI RATE] call=${u.call_count}% cpu=${u.total_cputime}% time=${u.total_time}%`
        );
      }
    } catch {
      /* ignore parse errors */
    }
  }

  const bucUsage = res.headers.get('x-business-use-case-usage');
  if (bucUsage) {
    try {
      const buc = JSON.parse(bucUsage);
      for (const entries of Object.values(buc)) {
        for (const e of entries) {
          if (
            e.call_count > RATE_LIMIT_THRESHOLD ||
            e.total_cputime > RATE_LIMIT_THRESHOLD ||
            e.total_time > RATE_LIMIT_THRESHOLD
          ) {
            console.warn(
              `[BUC ${e.type}] call=${e.call_count}% cpu=${e.total_cputime}% time=${e.total_time}% recover=${e.estimated_time_to_regain_access}min`
            );
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Envia eventos ao CAPI. Retorna `{ events_received, error? }`.
 * @param {Array} events - array de eventos no formato CAPI
 * @param {string} token - META_ACCESS_TOKEN
 * @param {object} [options]
 * @param {string} [options.pixelId] - override do pixel_id
 * @param {number} [options.maxRetries] - default 2
 */
export async function sendCapiEvents(events, token, options = {}) {
  const pixelId = options.pixelId || PIXEL_ID;
  const maxRetries = options.maxRetries ?? 2;
  const payload = { data: events, partner_agent: PARTNER_AGENT };

  // test_event_code: quando process.env.TEST_EVENT_CODE setado, anexa ao payload.
  // Meta Events Manager → aba "Teste de Eventos" exibe em real-time pra validação
  // (equivalente programático ao Payload Helper). Remover em prod de alto volume
  // — events com test_event_code não contam pra attribution/optimization.
  const testCode = options.testEventCode ?? process.env.TEST_EVENT_CODE;
  if (testCode) payload.test_event_code = testCode;

  // Fix MEDIUM AI deep v3 (capi.js:99): sendCapiEvents retornava undefined quando
  // todas retries esgotadas com is_transient=true. Agora: inicializa lastResult e
  // garante return com shape consistente. Callers podem confiar em result.error.
  let lastResult = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Fix INFO AI deep v3 (capi.js:89): defensive JSON parse + check response.ok.
    const res = await fetch(`${GRAPH_BASE}/${pixelId}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    monitorRateLimit(res);
    let result;
    const rawText = await res.text();
    try {
      result = JSON.parse(rawText);
    } catch {
      console.error(`[CAPI] Non-JSON response (${res.status}): ${rawText.substring(0,200)}`);
      result = { error: { message: 'non-json response', code: res.status, is_transient: true } };
    }
    lastResult = result;

    if (!result.error) return result;

    const { code, error_subcode, message, is_transient, blame_field_specs } = result.error;
    const blame = blame_field_specs ? ` blame=${JSON.stringify(blame_field_specs)}` : '';
    console.error(
      `[CAPI ERR attempt=${attempt}] code=${code} sub=${error_subcode} transient=${is_transient} msg=${message}${blame}`
    );

    if (!is_transient || attempt === maxRetries) return result;

    const delay = (attempt + 1) * 1000;
    await new Promise((r) => setTimeout(r, delay));
  }
  // Safety net: se loop sair sem return (impossível com maxRetries>=0 mas defensive).
  return lastResult || { error: { message: 'all retries exhausted', is_transient: true } };
}

/**
 * Valida e normaliza eventos antes de enviar. Remove inválidos e loga.
 * Meta rejeita o batch INTEIRO se 1 evento for inválido.
 *
 * Normalizações automáticas aplicadas:
 *  - event_time clamped ao intervalo [now-7d+margin, now] (evita 2804003 + futuro)
 *  - business_messaging sem messaging_channel → inválido (evita 2804063)
 */
export function filterValidEvents(events) {
  const nowSec = Math.floor(Date.now() / 1000);
  const minSec = nowSec - 7 * 24 * 3600 + 600;  // 7d window menos margem 10min
  // Fix MEDIUM AI deep v3 (capi.js:114): não mutar caller's events.
  // Antes: evt.event_time = nowSec dentro do filter mutava objetos originais.
  // Agora: retorna novos objetos com event_time clamped (immutable pattern).
  const out = [];
  for (const evt of events) {
    if (!evt.event_name || !evt.event_time || !evt.action_source) {
      console.warn(`[CAPI INVALID] missing required: ${evt.event_name || '?'}`);
      continue;
    }
    if (!evt.user_data || Object.keys(evt.user_data).length === 0) {
      console.warn(`[CAPI INVALID] empty user_data: ${evt.event_name}`);
      continue;
    }
    if (evt.action_source === 'business_messaging' && !evt.messaging_channel) {
      console.warn(`[CAPI INVALID] business_messaging sem messaging_channel: ${evt.event_name}`);
      continue;
    }
    // Defense-in-depth AI sanity v3: validar custom_data.value (número finito)
    // + currency (ISO 4217 = 3 letras uppercase) quando presentes. Meta rejeita
    // silenciosamente value string ou currency inválido → EMQ degradado.
    if (evt.custom_data) {
      const { value, currency } = evt.custom_data;
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        console.warn(`[CAPI INVALID] ${evt.event_name} custom_data.value não é number finito: ${value}`);
        continue;
      }
      if (currency !== undefined && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) {
        console.warn(`[CAPI INVALID] ${evt.event_name} custom_data.currency não é ISO 4217: ${currency}`);
        continue;
      }
    }
    // Clamp event_time se > now (futuro — não aceita) ou < now-7d (rejeita 2804003).
    let clampedTime = evt.event_time;
    if (clampedTime > nowSec) {
      console.warn(`[CAPI CLAMP] event_time futuro (${clampedTime} > ${nowSec}) → ajustado`);
      clampedTime = nowSec;
    } else if (clampedTime < minSec) {
      console.warn(`[CAPI CLAMP] event_time muito antigo (${clampedTime} < ${minSec}) → ajustado pra borda da janela`);
      clampedTime = minSec;
    }
    // Fix AI sanity v3: deep-copy user_data/custom_data quando clamping muda event_time.
    // Spread raso mantém referências — caller poderia mutar user_data depois do filter
    // e afetar o payload CAPI. Isolamento total previne race condition.
    if (clampedTime === evt.event_time) {
      out.push(evt);
    } else {
      out.push({
        ...evt,
        event_time: clampedTime,
        user_data: evt.user_data ? { ...evt.user_data } : evt.user_data,
        custom_data: evt.custom_data ? { ...evt.custom_data } : evt.custom_data,
      });
    }
  }
  return out;
}

/**
 * Combinações que a Meta rejeita (v13.0+). Retorna true se evento é matchable.
 */
export function hasMinimalMatching(userData) {
  // Pelo menos 1 dos: em, ph, fn+ln, external_id, fbp, fbc, madid
  return !!(
    userData.em ||
    userData.ph ||
    (userData.fn && userData.ln) ||
    userData.external_id ||
    userData.fbp ||
    userData.fbc ||
    userData.madid
  );
}
