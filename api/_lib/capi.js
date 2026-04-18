/**
 * Cliente CAPI compartilhado.
 * - Usa Authorization: Bearer (não expõe token na URL)
 * - Retry automático em erros transientes
 * - Monitora rate limit headers (X-App-Usage, X-Business-Use-Case-Usage)
 */

import { GRAPH_BASE, PIXEL_ID } from './config.js';

const RATE_LIMIT_THRESHOLD = 80; // alerta a 80% de uso

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
  const payload = { data: events };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${GRAPH_BASE}/${pixelId}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    monitorRateLimit(res);
    const result = await res.json();

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
  return events.filter((evt) => {
    if (!evt.event_name || !evt.event_time || !evt.action_source) {
      console.warn(`[CAPI INVALID] missing required: ${evt.event_name || '?'}`);
      return false;
    }
    if (!evt.user_data || Object.keys(evt.user_data).length === 0) {
      console.warn(`[CAPI INVALID] empty user_data: ${evt.event_name}`);
      return false;
    }
    // Business messaging requer messaging_channel (Meta oficial 2026).
    if (evt.action_source === 'business_messaging' && !evt.messaging_channel) {
      console.warn(`[CAPI INVALID] business_messaging sem messaging_channel: ${evt.event_name}`);
      return false;
    }
    // Clamp event_time se > now (futuro — não aceita) ou < now-7d (rejeita 2804003).
    if (evt.event_time > nowSec) {
      console.warn(`[CAPI CLAMP] event_time futuro (${evt.event_time} > ${nowSec}) → ajustado`);
      evt.event_time = nowSec;
    } else if (evt.event_time < minSec) {
      console.warn(`[CAPI CLAMP] event_time muito antigo (${evt.event_time} < ${minSec}) → ajustado pra borda da janela`);
      evt.event_time = minSec;
    }
    return true;
  });
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
