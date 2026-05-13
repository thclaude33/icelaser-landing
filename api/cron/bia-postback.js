// api/cron/bia-postback.js
// FALLBACK ONLY — quando handler bia-session-create.js timeout (45s) sem conseguir
// postar resposta (Bia ainda processando), este cron pega a resposta quando idle
// e posta no Chatwoot.
//
// DEDUP: Blob marker `bia/postback/posted/{session_id}.json` é gravado por:
//   1. Handler quando posta com sucesso inline (no path bia-session-create)
//   2. Este cron quando posta como fallback
// Antes de postar, AMBOS checam o marker. Zero race condition.

import { list, put } from '@vercel/blob';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://chatwoot-production-af5f.up.railway.app';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';

const BLOB_PREFIX = 'bia/postback/posted/';
const LOOKBACK_MIN = 10;
const MAX_PER_RUN = 15;

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  return auth === `Bearer ${expected}`;
}

function stripWhatsAppMarkdown(text) {
  return String(text || '')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/^---+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractClientResponse(text) {
  if (!text) return null;
  const blocks = text.split(/\n---+\n/).map((s) => s.trim()).filter(Boolean);
  for (const b of blocks) {
    if (/(\bOi[!,\s]|R\$|Sinto muito|Que (bom|legal|ótim)|Bu[çc]o|laser)/i.test(b) && b.length > 30 && b.length < 3000) {
      return b;
    }
  }
  if (blocks.length > 1) return blocks.sort((a, b) => b.length - a.length)[0];
  return text.trim();
}

async function fetchAnthropic(path) {
  const resp = await fetch(`${ANTHROPIC_BASE}${path}`, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY_ICELASER,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
    },
  });
  if (!resp.ok) throw new Error(`Anthropic ${path} HTTP ${resp.status}`);
  return resp.json();
}

async function alreadyPosted(sessionId) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return false;
  try {
    const { blobs } = await list({ prefix: `${BLOB_PREFIX}${sessionId}` });
    return blobs.length > 0;
  } catch {
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
  } catch {}
}

async function postChatwoot(convId, content) {
  const resp = await fetch(
    `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${convId}/messages`,
    {
      method: 'POST',
      headers: { 'api_access_token': process.env.CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, message_type: 'outgoing' }),
    }
  );
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Chatwoot ${resp.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.ANTHROPIC_API_KEY_ICELASER) return res.status(500).json({ error: 'missing_env' });
  if (!process.env.CHATWOOT_API_TOKEN) return res.status(500).json({ error: 'missing_env_chatwoot' });

  const stats = { scanned: 0, posted: 0, skipped_already: 0, skipped_processing: 0, skipped_no_content: 0, errors: 0, details: [] };
  const cutoff = Date.now() - LOOKBACK_MIN * 60 * 1000;

  try {
    const list_ = await fetchAnthropic('/sessions?limit=50');
    const sessions = (list_.data || []).filter((s) => {
      const md = s.metadata || {};
      if (md.source !== 'chatwoot_webhook') return false;
      if (!md.chatwoot_thread_id) return false;
      const created = new Date(s.created_at || 0).getTime();
      return created >= cutoff;
    }).slice(0, MAX_PER_RUN);

    stats.scanned = sessions.length;

    for (const s of sessions) {
      const sid = s.id;
      const convId = s.metadata?.chatwoot_thread_id;
      try {
        // DEDUP: handler já postou?
        if (await alreadyPosted(sid)) {
          stats.skipped_already += 1;
          continue;
        }
        const ev = await fetchAnthropic(`/sessions/${sid}/events?limit=100`);
        const events = ev.data || [];
        const hasIdle = events.some((e) => e.type === 'session.status_idle');
        if (!hasIdle) {
          stats.skipped_processing += 1;
          continue;
        }
        const agentMsgs = events.filter((e) => e.type === 'agent.message');
        let bestText = null;
        for (let i = agentMsgs.length - 1; i >= 0; i--) {
          for (const c of (agentMsgs[i].content || [])) {
            if (c.type === 'text' && c.text && /(R\$|\bOi[!,\s]|Sinto muito|atendente humana|consultora|💜|Bu[çc]o|laser)/i.test(c.text) && c.text.length > 30) {
              bestText = c.text;
              break;
            }
          }
          if (bestText) break;
        }
        if (!bestText && agentMsgs.length > 0) {
          for (const c of (agentMsgs[agentMsgs.length - 1].content || [])) {
            if (c.type === 'text' && c.text) { bestText = c.text; break; }
          }
        }
        if (!bestText) {
          stats.skipped_no_content += 1;
          continue;
        }
        const clean = stripWhatsAppMarkdown(extractClientResponse(bestText));
        if (!clean || clean.length < 10) {
          stats.skipped_no_content += 1;
          continue;
        }
        // RE-CHECK dedup right before posting (race window minimal)
        if (await alreadyPosted(sid)) {
          stats.skipped_already += 1;
          continue;
        }
        const posted = await postChatwoot(convId, clean);
        await markPosted(sid, {
          session_id: sid,
          conv_id: convId,
          chatwoot_msg_id: posted.id,
          posted_at: new Date().toISOString(),
          posted_by: 'cron_fallback',
        });
        stats.posted += 1;
        stats.details.push({ sid: sid.slice(-12), conv: convId, msg_id: posted.id });
      } catch (err) {
        stats.errors += 1;
        stats.details.push({ sid: sid.slice(-12), error: String(err?.message || err).slice(0, 150) });
      }
    }

    return res.status(200).json({ ok: true, stats });
  } catch (err) {
    return res.status(500).json({ error: 'unhandled', detail: String(err?.message || err) });
  }
}
