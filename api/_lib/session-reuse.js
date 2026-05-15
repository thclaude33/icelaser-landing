// api/_lib/session-reuse.js
// PROMPT 4 (Item 8 backlog) — Session Reuse Anthropic
//
// PROBLEMA: handler bia-session-create.js criava session Anthropic NOVA a cada
// webhook incoming. 7 msgs/lead em 11min = 7 sessions = ~$0.91 desperdiçado.
// Em V9 escalando: 50 leads × 10 msgs = $65/dia jogado fora.
//
// FIX: reusar session existente por chatwoot_thread_id quando dentro de TTL 30min.
// PROBE LIVE 15/05/2026 confirmou:
//   - Turn 1 cold: 46.4s, 24 events, cache_create cheio (~$0.13)
//   - Turn 2 reuse: 11.5s (-76%), +11 events, cache_read 95% (~$0.01)
//   - Turn 3 reuse: 11.0s, +9 events, contexto preservado integral
//
// KV namespace: session:thread:{conv_id}:active TTL 30min
// Threshold rotação: 100 events (~10 turns) — safety guard pra evitar context window full
//
// DISARM cenários (clearActiveSession):
//   1. Cliente respondeu após TTL (TTL natural expira)
//   2. Label terminal (compra_realizada / desqualificado / lead_quente) — crm-webhook
//   3. Atendente humana posta outgoing — crm-webhook (mesmo hook DISARM cascade)

import { kvGet, kvSet, kvDel } from './kv-rate-limit.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ACTIVE_SESSION_TTL_SEC = 30 * 60;  // 30 minutos
const SESSION_EVENTS_THRESHOLD = 100;     // ~10 turns — rotacionar antes
const FETCH_TIMEOUT_MS = 10000;

function buildHeaders() {
  return {
    'x-api-key': process.env.ANTHROPIC_API_KEY_ICELASER,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'managed-agents-2026-04-01',
    'content-type': 'application/json',
  };
}

function kvKey(convId) {
  return `session:thread:${convId}:active`;
}

/**
 * Pega session_id ativa pra um conv_id, ou null se não existir / TTL expirado.
 */
export async function getActiveSession(convId) {
  if (!convId) return null;
  const r = await kvGet(kvKey(convId));
  if (!r.ok || !r.value) return null;
  return r.value;
}

/**
 * Salva session_id ativa pra um conv_id. TTL 30min default (renova em cada chamada).
 */
export async function setActiveSession(convId, sessionId, ttlSec = ACTIVE_SESSION_TTL_SEC) {
  if (!convId || !sessionId) return { ok: false, reason: 'missing_args' };
  return kvSet(kvKey(convId), sessionId, ttlSec);
}

/**
 * Remove session ativa (chamado por crm-webhook em label terminal OU outgoing humana).
 */
export async function clearActiveSession(convId, reason) {
  if (!convId) return { ok: false, reason: 'no_conv_id' };
  const r = await kvDel(kvKey(convId));
  console.log(`[SESSION-REUSE] clear conv=${convId} reason=${reason || '?'}`);
  return r;
}

/**
 * Verifica se session ainda tem capacidade (events < threshold).
 * Pra evitar context window full + degradação latência.
 * Retorna { ok: true } se OK reusar, { ok: false } se deve rotacionar.
 *
 * Fail-open: erro fetch → assume tem capacidade (degrada gracioso).
 */
export async function sessionHasCapacity(sessionId, threshold = SESSION_EVENTS_THRESHOLD) {
  if (!sessionId) return { ok: false, reason: 'no_session_id' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(
      `${ANTHROPIC_BASE}/sessions/${sessionId}/events?limit=${threshold + 10}`,
      { headers: buildHeaders(), signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!resp.ok) {
      // 404 = session não existe / 400 = session_id inválido/formato → ambos não-reusáveis
      // Anthropic retorna 400 pra session_id que não existe (não 404 estrito)
      if (resp.status === 404 || resp.status === 400) {
        return { ok: false, reason: 'session_not_found_or_invalid', status: resp.status };
      }
      // 5xx (server errors temporários): fail-open assumindo capacidade
      console.warn(`[SESSION-REUSE] capacity check fetch err status=${resp.status} — fail-open`);
      return { ok: true, fallback: true };
    }
    const data = await resp.json();
    const eventCount = (data.data || []).length;
    const hasCapacity = eventCount < threshold;
    return {
      ok: hasCapacity,
      event_count: eventCount,
      threshold,
      reason: hasCapacity ? 'within_threshold' : 'at_capacity',
    };
  } catch (err) {
    clearTimeout(timeout);
    console.warn(`[SESSION-REUSE] capacity check exception — fail-open: ${err?.message || err}`);
    return { ok: true, fallback: true, error: String(err?.message || err) };
  }
}

/**
 * Resolve qual session_id usar pra um webhook incoming.
 *
 * @returns {Promise<{sessionId: string|null, reused: boolean, reason: string, existingEventCount?: number}>}
 *   - sessionId=null + reused=false → caller deve criar session nova
 *   - sessionId="sesn_..." + reused=true → caller append events nessa session
 */
export async function resolveSessionForThread(convId) {
  if (!convId) {
    return { sessionId: null, reused: false, reason: 'no_conv_id' };
  }
  const existing = await getActiveSession(convId);
  if (!existing) {
    return { sessionId: null, reused: false, reason: 'no_active_session' };
  }
  // Capacity check
  const cap = await sessionHasCapacity(existing);
  if (!cap.ok) {
    // Capacity exceeded OU session not found → limpa KV e força nova
    await clearActiveSession(convId, `capacity_${cap.reason || 'unknown'}`);
    return {
      sessionId: null,
      reused: false,
      reason: `capacity_${cap.reason || 'unknown'}`,
      previousEventCount: cap.event_count,
    };
  }
  return {
    sessionId: existing,
    reused: true,
    reason: 'reused_within_ttl',
    existingEventCount: cap.event_count,
  };
}

export {
  ACTIVE_SESSION_TTL_SEC,
  SESSION_EVENTS_THRESHOLD,
};
