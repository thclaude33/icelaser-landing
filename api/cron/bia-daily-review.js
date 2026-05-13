// api/cron/bia-daily-review.js
// P9.7 — Cron diário (Vercel) que pede pro Bia Learning Mode processar conversas das últimas 24h
// e gerar relatório em bia-learnings/daily_review/{YYYY-MM-DD}.md.

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const BIA_LEARNING_AGENT_ID = 'agent_01FjS6Unkb4y8RjnwfuBbAsW'; // v5
const ENV_ID = 'env_01ANo8eEPnZ3P51da4TQz2HR';

const BIA_LEARNINGS = 'memstore_017a67p42zpRC97fiXdvZjtX';
const BIA_LEAD_PROFILES = 'memstore_01SgUbvr1THw4X5fZHr4SRan';
const BIA_AUDIT_LOG = 'memstore_014QBMrxVyhm2u2P3x3MzvGr';
const KB_MASTER = 'memstore_01QLnM9ZTBG1U4WMKT7J19x6';

function isAuthorized(req) {
  // Vercel envia Authorization: Bearer ${CRON_SECRET} pra cron jobs.
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  return auth === `Bearer ${expected}`;
}

function brtDateISO() {
  // YYYY-MM-DD em America/Sao_Paulo
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
  return fmt.format(new Date());
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY_ICELASER;
  if (!apiKey) {
    return res.status(500).json({ error: 'missing_env', detail: 'ANTHROPIC_API_KEY_ICELASER not set' });
  }

  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'managed-agents-2026-04-01',
    'content-type': 'application/json',
  };

  const date = brtDateISO();
  const prompt = [
    `Daily Review automático (${date} BRT).`,
    `Tarefa:`,
    `1. Ler todos os arquivos em /mnt/memory/bia-learnings/few_shot/* atualizados nas últimas 24h.`,
    `2. Detectar patterns transversais (≥3 conversas) — objeções, perguntas, divergências vs KB.`,
    `3. Escrever relatório em /mnt/memory/bia-learnings/daily_review/${date}.md seguindo o schema em /mnt/memory/bia-learnings/_SCHEMA_TEMPLATE_DAILY_REVIEW.md.`,
    `4. Listar cobranças pendentes pra Vitória (gaps KB).`,
    `5. Confirmar com summary curto + caminho do arquivo escrito.`,
  ].join('\n');

  try {
    // 1. Criar session com Bia Learning Mode + 4 stores
    const sessResp = await fetch(`${ANTHROPIC_BASE}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agent: BIA_LEARNING_AGENT_ID,
        environment_id: ENV_ID,
        title: `Daily Review ${date}`,
        metadata: { kind: 'daily_review', date },
        resources: [
          { type: 'memory_store', memory_store_id: KB_MASTER },
          { type: 'memory_store', memory_store_id: BIA_LEARNINGS },
          { type: 'memory_store', memory_store_id: BIA_LEAD_PROFILES },
          { type: 'memory_store', memory_store_id: BIA_AUDIT_LOG },
        ],
      }),
    });
    const sessText = await sessResp.text();
    if (!sessResp.ok) {
      return res.status(502).json({ error: 'session_create_failed', status: sessResp.status, detail: sessText.slice(0, 500) });
    }
    const session = JSON.parse(sessText);

    // 2. Enviar prompt
    const evResp = await fetch(`${ANTHROPIC_BASE}/sessions/${session.id}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }],
      }),
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

    return res.status(200).json({
      ok: true,
      learning_session_id: session.id,
      date,
      note: 'Bia Learning Mode rodando em background. Polling via /api/bia-session-poll?session_id=...',
    });
  } catch (err) {
    return res.status(500).json({ error: 'unhandled', detail: String(err?.message || err) });
  }
}
