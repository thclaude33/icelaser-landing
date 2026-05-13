// api/bia-session-create.js
// P9.7 — Cria session Anthropic Managed Agents (Bia Coordinator + 4 memory stores).
//
// Aceita 2 formatos de input:
//   A) DIRECT API: { telefone, mensagem_cliente, chatwoot_thread_id? }
//   B) CHATWOOT WEBHOOK: payload flat { event, conversation, sender, content, ... }
//      → normaliza pra (A) + filtros Shadow Mode antes de criar session.
//
// Filtros Shadow Mode (Chatwoot webhook path):
//   - event === 'message_created'
//   - message_type === 'incoming' (ou 0 — só msg do cliente, ignora bot/agent)
//   - inbox.id === SHADOW_INBOX_ID (default 7 = WhatsApp IceLaser)
//   - labels conversation contém 'bia_teste' (gate user-controlled)
//
// Auth Chatwoot: ?auth=<CHATWOOT_WEBHOOK_QUERY_TOKEN> (mesmo mecanismo crm-webhook).
//
// Schema Anthropic LIVE: resources aceita SÓ { type, memory_store_id }.

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const COORDINATOR_AGENT_ID = 'agent_018zZxrjHftuiePCuJEUNTqL'; // Coordinator v17 Sonnet 4.6
const ENV_ID = 'env_01ANo8eEPnZ3P51da4TQz2HR';

const KB_MASTER = 'memstore_01QLnM9ZTBG1U4WMKT7J19x6';
const BIA_LEARNINGS = 'memstore_017a67p42zpRC97fiXdvZjtX';
const BIA_LEAD_PROFILES = 'memstore_01SgUbvr1THw4X5fZHr4SRan';
const BIA_AUDIT_LOG = 'memstore_014QBMrxVyhm2u2P3x3MzvGr';

const SHADOW_INBOX_ID = parseInt(process.env.BIA_SHADOW_INBOX_ID || '7', 10);
const SHADOW_LABEL = process.env.BIA_SHADOW_LABEL || 'bia_teste';

function buildHeaders(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'managed-agents-2026-04-01',
    'content-type': 'application/json',
  };
}

function checkAuth(req) {
  const expected = process.env.CHATWOOT_WEBHOOK_QUERY_TOKEN;
  if (!expected) return { ok: true, mode: 'no_auth_configured' };
  const queryAuth = req.query?.auth || '';
  const headerAuth = req.headers?.['x-webhook-token'] || '';
  if (queryAuth === expected || headerAuth === expected) {
    return { ok: true, mode: 'query_token' };
  }
  return { ok: false, mode: 'missing_or_invalid' };
}

// Detecta payload Chatwoot — chave `event` + ausência de `mensagem_cliente`
function isChatwootPayload(body) {
  return typeof body?.event === 'string' && !body.mensagem_cliente;
}

// Normaliza payload Chatwoot message_created → { telefone, mensagem_cliente, ..., skip? }
function normalizeChatwoot(body) {
  const event = body.event;
  const messageType = body.message_type; // 'incoming' | 'outgoing' | 0 | 1

  // Filtro 1: event tipo
  if (event !== 'message_created') {
    return { skip: true, reason: 'event_not_message_created', event };
  }

  // Filtro 2: incoming only
  const isIncoming = messageType === 'incoming' || messageType === 0;
  if (!isIncoming) {
    return { skip: true, reason: 'message_not_incoming', message_type: messageType };
  }

  // Filtro 3: inbox correto
  const inboxId = body.inbox?.id ?? body.conversation?.inbox_id ?? body.inbox_id;
  if (Number(inboxId) !== SHADOW_INBOX_ID) {
    return { skip: true, reason: 'inbox_not_shadow', inbox_id: inboxId, expected: SHADOW_INBOX_ID };
  }

  // Filtro 4: gate label (Shadow Mode)
  const labels = Array.isArray(body.conversation?.labels)
    ? body.conversation.labels
    : Array.isArray(body.labels)
    ? body.labels
    : typeof body.conversation?.cached_label_list === 'string'
    ? body.conversation.cached_label_list.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  if (!labels.includes(SHADOW_LABEL)) {
    return { skip: true, reason: 'label_gate_not_present', labels, expected_label: SHADOW_LABEL };
  }

  // Filtro 5: pular mensagens vazias / private notes
  const isPrivate = body.private === true;
  if (isPrivate) {
    return { skip: true, reason: 'private_note' };
  }

  const content = String(body.content || '').trim();
  if (!content) {
    return { skip: true, reason: 'empty_content' };
  }

  // Extrair telefone
  const phone =
    body.sender?.phone_number ||
    body.conversation?.meta?.sender?.phone_number ||
    body.contact?.phone_number ||
    '';
  const telefone = String(phone || '').replace(/^\+/, '').replace(/\D/g, '');
  if (!telefone) {
    return { skip: true, reason: 'no_phone_number' };
  }

  const conversation_id = body.conversation?.id ?? body.conversation_id ?? null;
  const sender_name = body.sender?.name || body.conversation?.meta?.sender?.name || null;

  return {
    skip: false,
    telefone,
    mensagem_cliente: content,
    chatwoot_thread_id: conversation_id ? String(conversation_id) : null,
    sender_name,
    chatwoot_message_id: body.id ?? null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY_ICELASER;
  if (!apiKey) {
    return res.status(500).json({ error: 'missing_env', detail: 'ANTHROPIC_API_KEY_ICELASER not set' });
  }

  const rawBody = req.body || {};

  // Caminho B — Chatwoot webhook
  let telefone;
  let mensagem_cliente;
  let chatwoot_thread_id;
  let extra = {};
  let source = 'direct';

  if (isChatwootPayload(rawBody)) {
    source = 'chatwoot_webhook';
    // Auth obrigatório quando payload Chatwoot
    const auth = checkAuth(req);
    if (!auth.ok) {
      return res.status(401).json({ error: 'unauthorized', detail: auth.mode });
    }
    const normalized = normalizeChatwoot(rawBody);
    if (normalized.skip) {
      // Retorna 200 OK pra Chatwoot não tentar retransmitir — evento simplesmente foi filtrado.
      return res.status(200).json({ ok: true, skipped: true, reason: normalized.reason, source });
    }
    telefone = normalized.telefone;
    mensagem_cliente = normalized.mensagem_cliente;
    chatwoot_thread_id = normalized.chatwoot_thread_id;
    extra = {
      sender_name: normalized.sender_name,
      chatwoot_message_id: normalized.chatwoot_message_id,
    };
  } else {
    // Caminho A — Direct API
    telefone = String(rawBody.telefone || '').trim();
    mensagem_cliente = String(rawBody.mensagem_cliente || '').trim();
    chatwoot_thread_id = rawBody.chatwoot_thread_id ?? null;
    if (!telefone || !mensagem_cliente) {
      return res.status(400).json({
        error: 'bad_request',
        detail: 'telefone + mensagem_cliente obrigatórios (caminho direct) OU envie payload Chatwoot com {event, conversation, sender, content}',
      });
    }
  }

  const headers = buildHeaders(apiKey);

  try {
    // 1. Criar session
    const sessionPayload = {
      agent: COORDINATOR_AGENT_ID,
      environment_id: ENV_ID,
      title: `Bia atende ${telefone}`,
      metadata: {
        telefone,
        inicio: new Date().toISOString(),
        source,
        // Anthropic metadata.* rejeita null — usar spread condicional pra omitir quando ausente
        ...(chatwoot_thread_id ? { chatwoot_thread_id: String(chatwoot_thread_id) } : {}),
        ...(extra.sender_name ? { sender_name: extra.sender_name } : {}),
        ...(extra.chatwoot_message_id ? { chatwoot_message_id: String(extra.chatwoot_message_id) } : {}),
      },
      resources: [
        { type: 'memory_store', memory_store_id: KB_MASTER },
        { type: 'memory_store', memory_store_id: BIA_LEARNINGS },
        { type: 'memory_store', memory_store_id: BIA_LEAD_PROFILES },
        { type: 'memory_store', memory_store_id: BIA_AUDIT_LOG },
      ],
    };

    const sessResp = await fetch(`${ANTHROPIC_BASE}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(sessionPayload),
    });
    const sessText = await sessResp.text();
    if (!sessResp.ok) {
      return res.status(502).json({ error: 'session_create_failed', status: sessResp.status, detail: sessText.slice(0, 500), source });
    }
    const session = JSON.parse(sessText);
    if (!session.id) {
      return res.status(502).json({ error: 'session_no_id', detail: sessText.slice(0, 500), source });
    }

    // 2. Enviar mensagem cliente prefixada com TELEFONE_CLIENTE pra decision tree
    const mensagemComPrefixo = `(TELEFONE_CLIENTE: +${telefone}) ${mensagem_cliente}`;
    const eventPayload = {
      events: [
        { type: 'user.message', content: [{ type: 'text', text: mensagemComPrefixo }] },
      ],
    };
    const evResp = await fetch(`${ANTHROPIC_BASE}/sessions/${session.id}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(eventPayload),
    });
    const evText = await evResp.text();
    if (!evResp.ok) {
      return res.status(502).json({
        error: 'event_send_failed',
        session_id: session.id,
        status: evResp.status,
        detail: evText.slice(0, 500),
        source,
      });
    }
    let event;
    try {
      event = JSON.parse(evText);
    } catch {
      event = { raw: evText.slice(0, 200) };
    }

    return res.status(200).json({
      success: true,
      source,
      session_id: session.id,
      event_id: event?.data?.[0]?.id ?? event?.id ?? null,
      resources_attached: session.resources?.length ?? null,
      ...(extra.chatwoot_message_id ? { chatwoot_message_id: extra.chatwoot_message_id } : {}),
    });
  } catch (err) {
    return res.status(500).json({ error: 'unhandled', detail: String(err?.message || err), source });
  }
}
