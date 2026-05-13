// api/cron/bia-postback.js
// Cron Vercel: a cada 1 min varre sessions Bia recentes (criadas via Chatwoot webhook),
// pega última agent.message NOVA (não postada ainda) e posta no Chatwoot conv
// como outgoing → WhatsApp Cloud entrega no cliente.
//
// Dedup: usa Vercel Blob pra marcar quais (session_id, agent_event_id) já postaram.

import { list, put } from '@vercel/blob';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://chatwoot-production-af5f.up.railway.app';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';

const BLOB_PREFIX = 'bia/postback/posted/';
const BLOB_LOOKBACK_MIN = 30; // só sessions criadas nos últimos 30min
const MAX_SESSIONS_PER_RUN = 20;

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  return auth === `Bearer ${expected}`;
}

function stripMarkdown(text) {
  // WhatsApp suporta *negrito* simples mas NÃO **negrito duplo** (que Bia gera).
  // Converte **xxx** → *xxx*. Mantém emojis.
  return text
    .replace(/\*\*([^*]+)\*\*/g, '*$1*') // bold duplo → bold simples
    .replace(/^---+\s*$/gm, '') // remove separadores ---
    .replace(/\n{3,}/g, '\n\n') // colapsa linhas vazias múltiplas
    .trim();
}

// Extrai a "resposta cliente" final de uma agent.message text.
// Bia gera blocos longos com meta-comentário interno. Resposta cliente normalmente
// está depois de "---" ou começa com "Oi" / inclui R$ / saudação.
function extractClientResponse(text) {
  if (!text) return null;
  // Procurar bloco entre "---\n\n" tipicamente
  const blocks = text.split(/\n---+\n/).map((s) => s.trim()).filter(Boolean);
  // Preferir bloco que tem "Oi" ou "R$" ou que começa com letra (cliente-facing)
  for (const b of blocks) {
    if (/(\bOi[!,\s]|R\$|Sinto muito|Que (bom|legal|ótim))/i.test(b) && b.length > 30 && b.length < 3000) {
      return b;
    }
  }
  // Fallback: bloco mais longo se múltiplos
  if (blocks.length > 1) {
    return blocks.sort((a, b) => b.length - a.length)[0];
  }
  return text.trim();
}

async function fetchAnthropic(path) {
  const headers = {
    'x-api-key': process.env.ANTHROPIC_API_KEY_ICELASER,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'managed-agents-2026-04-01',
  };
  const resp = await fetch(`${ANTHROPIC_BASE}${path}`, { headers });
  if (!resp.ok) throw new Error(`Anthropic ${path} HTTP ${resp.status}`);
  return resp.json();
}

async function postChatwootMessage(convId, content) {
  const resp = await fetch(
    `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${convId}/messages`,
    {
      method: 'POST',
      headers: {
        'api_access_token': process.env.CHATWOOT_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content, message_type: 'outgoing' }),
    }
  );
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Chatwoot POST HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp.json();
}

async function alreadyPosted(sessionId) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return false;
  try {
    const { blobs } = await list({ prefix: `${BLOB_PREFIX}${sessionId}` });
    return blobs.length > 0;
  } catch (e) {
    return false;
  }
}

async function markPosted(sessionId, payload) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    await put(`${BLOB_PREFIX}${sessionId}.json`, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
    });
  } catch (e) {
    // swallow — dedup best-effort
  }
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.ANTHROPIC_API_KEY_ICELASER) {
    return res.status(500).json({ error: 'missing_env', detail: 'ANTHROPIC_API_KEY_ICELASER' });
  }
  if (!process.env.CHATWOOT_API_TOKEN) {
    return res.status(500).json({ error: 'missing_env', detail: 'CHATWOOT_API_TOKEN' });
  }

  const stats = { sessions_scanned: 0, posted: 0, skipped: 0, errors: 0, details: [] };
  const cutoff = Date.now() - BLOB_LOOKBACK_MIN * 60 * 1000;

  try {
    const list_ = await fetchAnthropic('/sessions?limit=50');
    const sessions = (list_.data || []).filter((s) => {
      const md = s.metadata || {};
      if (md.source !== 'chatwoot_webhook') return false;
      if (!md.chatwoot_thread_id) return false;
      const created = new Date(s.created_at || 0).getTime();
      return created >= cutoff;
    }).slice(0, MAX_SESSIONS_PER_RUN);

    stats.sessions_scanned = sessions.length;

    for (const s of sessions) {
      const sid = s.id;
      const convId = s.metadata?.chatwoot_thread_id;
      try {
        if (await alreadyPosted(sid)) {
          stats.skipped += 1;
          continue;
        }
        // Fetch events
        const ev = await fetchAnthropic(`/sessions/${sid}/events?limit=100`);
        const events = ev.data || [];
        const sessionStatus = ev.status || s.status;
        // Só posta se session estiver idle (terminou) — evita postar meio-de-thinking
        const hasIdle = events.some((e) => e.type === 'session.status_idle');
        if (!hasIdle && sessionStatus !== 'idle') {
          stats.skipped += 1;
          stats.details.push({ sid, conv: convId, reason: 'still_processing' });
          continue;
        }
        // Última agent.message com conteúdo cliente-facing
        const agentMsgs = events.filter((e) => e.type === 'agent.message');
        if (agentMsgs.length === 0) {
          stats.skipped += 1;
          stats.details.push({ sid, conv: convId, reason: 'no_agent_message' });
          continue;
        }
        let bestText = null;
        for (let i = agentMsgs.length - 1; i >= 0; i--) {
          const content = agentMsgs[i].content || [];
          for (const c of content) {
            if (c.type === 'text' && c.text) {
              if (/(R\$|\bOi[!,\s]|Sinto muito|atendente humana|consultora)/i.test(c.text) && c.text.length > 50) {
                bestText = c.text;
                break;
              }
            }
          }
          if (bestText) break;
        }
        if (!bestText) {
          // fallback: última text
          const last = agentMsgs[agentMsgs.length - 1].content || [];
          for (const c of last) if (c.type === 'text') { bestText = c.text; break; }
        }
        if (!bestText) {
          stats.skipped += 1;
          stats.details.push({ sid, conv: convId, reason: 'no_text_content' });
          continue;
        }
        const clientResponse = extractClientResponse(bestText);
        const clean = stripMarkdown(clientResponse);
        if (!clean || clean.length < 10) {
          stats.skipped += 1;
          stats.details.push({ sid, conv: convId, reason: 'response_too_short' });
          continue;
        }
        // Post no Chatwoot
        const posted = await postChatwootMessage(convId, clean);
        await markPosted(sid, {
          session_id: sid,
          conv_id: convId,
          chatwoot_msg_id: posted.id,
          posted_at: new Date().toISOString(),
          content_preview: clean.slice(0, 100),
        });
        stats.posted += 1;
        stats.details.push({ sid, conv: convId, chatwoot_msg_id: posted.id, status: 'posted' });
      } catch (err) {
        stats.errors += 1;
        stats.details.push({ sid, conv: convId, error: String(err?.message || err).slice(0, 200) });
      }
    }

    return res.status(200).json({ ok: true, stats });
  } catch (err) {
    return res.status(500).json({ error: 'unhandled', detail: String(err?.message || err) });
  }
}
