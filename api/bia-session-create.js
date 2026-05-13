// api/bia-session-create.js
// P9.7 — Cria session Anthropic Managed Agents com Bia Coordinator + 4 memory stores attached.
// Schema descoberto LIVE 13/05/2026: resources aceita SÓ {type, memory_store_id} (sem mount_path/permission).

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const COORDINATOR_AGENT_ID = 'agent_018zZxrjHftuiePCuJEUNTqL'; // v9
const ENV_ID = 'env_01ANo8eEPnZ3P51da4TQz2HR';

const KB_MASTER = 'memstore_01QLnM9ZTBG1U4WMKT7J19x6';
const BIA_LEARNINGS = 'memstore_017a67p42zpRC97fiXdvZjtX';
const BIA_LEAD_PROFILES = 'memstore_01SgUbvr1THw4X5fZHr4SRan';
const BIA_AUDIT_LOG = 'memstore_014QBMrxVyhm2u2P3x3MzvGr';

function buildHeaders(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'managed-agents-2026-04-01',
    'content-type': 'application/json',
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

  const body = req.body || {};
  const telefone = String(body.telefone || '').trim();
  const mensagem_cliente = String(body.mensagem_cliente || '').trim();
  const chatwoot_thread_id = body.chatwoot_thread_id ?? null;

  if (!telefone || !mensagem_cliente) {
    return res.status(400).json({ error: 'bad_request', detail: 'telefone + mensagem_cliente obrigatórios' });
  }

  const headers = buildHeaders(apiKey);

  try {
    // 1. Criar session (Coordinator + 4 stores)
    const sessionPayload = {
      agent: COORDINATOR_AGENT_ID,
      environment_id: ENV_ID,
      title: `Bia atende ${telefone}`,
      metadata: {
        telefone,
        chatwoot_thread_id: chatwoot_thread_id ? String(chatwoot_thread_id) : null,
        inicio: new Date().toISOString(),
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
      return res.status(502).json({ error: 'session_create_failed', status: sessResp.status, detail: sessText.slice(0, 500) });
    }
    const session = JSON.parse(sessText);
    if (!session.id) {
      return res.status(502).json({ error: 'session_no_id', detail: sessText.slice(0, 500) });
    }

    // 2. Enviar 1ª mensagem do cliente
    // CRITICAL — injetar prefixo `(TELEFONE_CLIENTE: +XXX)` pra Coordinator conseguir:
    //   (a) buscar profile.md em /mnt/memory/bia-lead-profiles/{tel}/
    //   (b) aplicar GEO-FLAG (DDD distante = clínica presencial Recife)
    //   (c) escolher cenário saudação A/B/C/D corretamente
    // Sem isso, Bia só vê msg cliente e não tem como cravar telefone na decision tree.
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
      });
    }
    let event;
    try { event = JSON.parse(evText); } catch { event = { raw: evText.slice(0, 200) }; }

    return res.status(200).json({
      success: true,
      session_id: session.id,
      event_id: event?.data?.[0]?.id ?? event?.id ?? null,
      resources_attached: session.resources?.length ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'unhandled', detail: String(err?.message || err) });
  }
}
