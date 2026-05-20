// api/bia-direct.js
// FASE 3.6 — Direct path Bia (admin/test trigger, nao-Chatwoot).
//
// PROPOSITO:
//   - Admin trigger pra testes / smokes sem precisar criar contact+conv Chatwoot
//   - Bot Welcome migration futura (se quiser unificar fluxo)
//   - E2E tests controlados (sem poluir conv reais)
//
// NAO substitui webhook Chatwoot id=7 — fluxo CRM continua como esta.
//
// AUTH:
//   Header Authorization: Bearer ${BIA_DIRECT_API_KEY}
//   Secret 32-byte hex gerado 15/05/2026, armazenado em env vars dos 3 projetos Vercel.
//
// PAYLOAD:
//   {
//     "telefone": "5581988888888",
//     "mensagem_cliente": "texto",
//     "source": "admin_smoke" | "bot_welcome" | "e2e_test",
//     "metadata": {}
//   }
//
// RESPONSE:
//   - 200 { success, session_id, agent_message, elapsed_ms }
//   - 401 unauthorized
//   - 429 rate_limit_in_flight
//   - 502 session_create_failed / event_send_failed
//   - 500 unhandled

import { kvClaim, kvRelease } from './_lib/kv-rate-limit.js';
import { shouldSendNow } from './_lib/send-window.js';
import { responseOrFallbackFromEvents } from './_lib/bia-client-response.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const COORDINATOR_AGENT_ID = 'agent_018zZxrjHftuiePCuJEUNTqL';
const ENV_ID = 'env_01ANo8eEPnZ3P51da4TQz2HR';
const KB_MASTER = 'memstore_01QLnM9ZTBG1U4WMKT7J19x6';
const BIA_LEARNINGS = 'memstore_017a67p42zpRC97fiXdvZjtX';
const BIA_LEAD_PROFILES = 'memstore_01SgUbvr1THw4X5fZHr4SRan';
const BIA_AUDIT_LOG = 'memstore_014QBMrxVyhm2u2P3x3MzvGr';

const POLLING_TIMEOUT_MS = 55000;
const POLLING_TICK_MS = 1500;
const KV_CLAIM_TTL_SEC = 90;

function buildAnthropicHeaders() {
  return {
    'x-api-key': process.env.ANTHROPIC_API_KEY_ICELASER,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'managed-agents-2026-04-01',
    'content-type': 'application/json',
  };
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(req) {
  const expected = process.env.BIA_DIRECT_API_KEY;
  if (!expected) return { ok: false, reason: 'missing_env_BIA_DIRECT_API_KEY' };
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (!m) return { ok: false, reason: 'missing_or_malformed_bearer' };
  if (!safeCompare(m[1], expected)) return { ok: false, reason: 'invalid_bearer' };
  return { ok: true };
}

async function pollSessionUntilIdle(sessionId, deadlineMs, headers) {
  while (Date.now() < deadlineMs) {
    const resp = await fetch(`${ANTHROPIC_BASE}/sessions/${sessionId}/events?limit=100`, { headers });
    if (!resp.ok) return { ready: false, error: `events_fetch_${resp.status}` };
    const data = await resp.json();
    const events = data.data || [];
    const hasIdle = events.some((e) => e.type === 'session.status_idle');
    const hasError = events.some((e) => e.type === 'session.error');
    if (hasError) return { ready: false, error: 'session.error' };
    if (hasIdle) {
      const extracted = responseOrFallbackFromEvents(events);
      if (!extracted.ok) return { ready: false, error: extracted.reason || 'no_text_found_but_idle' };
      return {
        ready: true,
        text: extracted.text,
        agentMsgIdx: extracted.agentMsgIdx,
        extraction_source: extracted.source,
        fallback: extracted.fallback === true,
        blocked_reason: extracted.blockedReason || null,
      };
    }
    await new Promise((r) => setTimeout(r, POLLING_TICK_MS));
  }
  return { ready: false, error: 'timeout' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const auth = isAuthorized(req);
  if (!auth.ok) {
    return res.status(401).json({ error: 'unauthorized', reason: auth.reason });
  }

  if (!process.env.ANTHROPIC_API_KEY_ICELASER) {
    return res.status(500).json({ error: 'missing_env_anthropic' });
  }

  let body;
  try {
    body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    return res.status(400).json({ error: 'bad_json', detail: String(e?.message || e) });
  }

  const telefone = String(body.telefone || '').replace(/[^\d]/g, '').trim();
  const mensagem = String(body.mensagem_cliente || '').trim();
  const source = String(body.source || 'direct').trim();
  const userMetadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};

  if (!telefone || telefone.length < 10 || telefone.length > 15) {
    return res.status(400).json({ error: 'bad_telefone', detail: 'esperado 10-15 digitos sem +' });
  }
  if (!mensagem || mensagem.length < 1) {
    return res.status(400).json({ error: 'bad_mensagem' });
  }

  const kvClaimKey = `rl:phone:${telefone}:direct:in_flight`;
  const kvClaimValue = `direct_${Date.now()}`;
  const claim = await kvClaim(kvClaimKey, kvClaimValue, KV_CLAIM_TTL_SEC);
  if (!claim.ok && !claim.fallback) {
    return res.status(429).json({
      error: 'rate_limit_in_flight',
      detail: 'Outra requisicao direct ainda processando este telefone',
      claim_key: kvClaimKey,
      existing_claim: claim.existing,
    });
  }

  const sessionType = (source === 'proactive_followup' || source === 'cascade') ? 'proactive_followup' : 'reactive_reply';
  const windowGate = shouldSendNow({ session_type: sessionType });
  if (!windowGate.ok) {
    await kvRelease(kvClaimKey);
    return res.status(202).json({
      ok: true,
      blocked: 'outside_send_window',
      reason: windowGate.reason,
      next_send_at: windowGate.next_send_at,
      session_type: sessionType,
    });
  }

  const t_start = Date.now();
  const headers = buildAnthropicHeaders();

  try {
    const sessionPayload = {
      agent: COORDINATOR_AGENT_ID,
      environment_id: ENV_ID,
      title: `Bia direct ${telefone}`,
      metadata: {
        telefone,
        inicio: new Date().toISOString(),
        source,
        session_type: sessionType,
        ...userMetadata,
      },
      resources: [
        { type: 'memory_store', memory_store_id: KB_MASTER },
        { type: 'memory_store', memory_store_id: BIA_LEARNINGS },
        { type: 'memory_store', memory_store_id: BIA_LEAD_PROFILES },
        { type: 'memory_store', memory_store_id: BIA_AUDIT_LOG },
      ],
    };
    const sResp = await fetch(`${ANTHROPIC_BASE}/sessions`, {
      method: 'POST', headers, body: JSON.stringify(sessionPayload),
    });
    const sText = await sResp.text();
    if (!sResp.ok) {
      return res.status(502).json({ error: 'session_create_failed', status: sResp.status, detail: sText.slice(0, 500) });
    }
    const session = JSON.parse(sText);
    if (!session.id) {
      return res.status(502).json({ error: 'session_no_id', detail: sText.slice(0, 500) });
    }

    const mensagemPrefixada = `(TELEFONE_CLIENTE: +${telefone}) ${mensagem}`;
    const evPayload = {
      events: [{ type: 'user.message', content: [{ type: 'text', text: mensagemPrefixada }] }],
    };
    const eResp = await fetch(`${ANTHROPIC_BASE}/sessions/${session.id}/events`, {
      method: 'POST', headers, body: JSON.stringify(evPayload),
    });
    if (!eResp.ok) {
      const eText = await eResp.text();
      return res.status(502).json({ error: 'event_send_failed', session_id: session.id, status: eResp.status, detail: eText.slice(0, 500) });
    }

    const deadline = t_start + POLLING_TIMEOUT_MS;
    const result = await pollSessionUntilIdle(session.id, deadline, headers);
    const elapsed_ms = Date.now() - t_start;

    if (result.ready && result.text) {
      return res.status(200).json({
        success: true,
        session_id: session.id,
        agent_message: result.text,
        extraction_source: result.extraction_source || null,
        fallback: result.fallback === true,
        blocked_reason: result.blocked_reason || null,
        source,
        elapsed_ms,
        resources_attached: session.resources?.length ?? null,
      });
    }

    return res.status(202).json({
      ok: true,
      session_id: session.id,
      ready: false,
      reason: result.error || 'unknown',
      elapsed_ms,
      hint: 'Session ainda processando — direct path nao tem cron fallback',
    });
  } catch (err) {
    return res.status(500).json({ error: 'unhandled', detail: String(err?.message || err) });
  } finally {
    try { await kvRelease(kvClaimKey); }
    catch (e) { console.error(`[BIA-DIRECT-KV-RELEASE] ${kvClaimKey}: ${e?.message || e}`); }
  }
}
