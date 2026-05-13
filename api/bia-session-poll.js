// api/bia-session-poll.js
// P9.7 — Polling de eventos da session Bia. Retorna última resposta agent.message + status.

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY_ICELASER;
  if (!apiKey) {
    return res.status(500).json({ error: 'missing_env', detail: 'ANTHROPIC_API_KEY_ICELASER not set' });
  }

  const session_id = String(req.query?.session_id || '').trim();
  if (!session_id || !session_id.startsWith('sesn_')) {
    return res.status(400).json({ error: 'bad_request', detail: 'session_id obrigatório (formato sesn_*)' });
  }
  const limit = Math.min(parseInt(req.query?.limit || '50', 10) || 50, 200);

  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'managed-agents-2026-04-01',
  };

  try {
    const resp = await fetch(`${ANTHROPIC_BASE}/sessions/${session_id}/events?limit=${limit}`, { headers });
    const text = await resp.text();
    if (!resp.ok) {
      return res.status(502).json({ error: 'poll_failed', status: resp.status, detail: text.slice(0, 500) });
    }
    const data = JSON.parse(text);
    const events = Array.isArray(data.data) ? data.data : [];

    const agentMessages = events.filter((e) => e.type === 'agent.message');
    const last = agentMessages.length ? agentMessages[agentMessages.length - 1] : null;
    const lastText = last?.content?.find?.((c) => c?.type === 'text')?.text || '';

    return res.status(200).json({
      session_id,
      bia_response: lastText,
      session_status: data.status || null,
      events_total: events.length,
      agent_messages_total: agentMessages.length,
    });
  } catch (err) {
    return res.status(500).json({ error: 'unhandled', detail: String(err?.message || err) });
  }
}
