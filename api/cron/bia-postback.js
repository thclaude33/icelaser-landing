// api/cron/bia-postback.js
// FALLBACK ONLY — quando handler bia-session-create.js timeout (55s) sem conseguir
// postar resposta (Bia ainda processando), este cron pega a resposta quando idle
// e posta no Chatwoot.
//
// DEDUP (FASE 2 — 15/05/2026): Blob marker key SHIFT
//   ANTES: `bia/postback/posted/{session_id}.json`
//   AGORA: `bia/postback/posted/msg_{chatwoot_message_id}.json` (preferred)
//           fallback `bia/postback/posted/sess_{session_id}.json`
//   Motivo: Chatwoot retry pode abrir 2 sessions diferentes pra mesma msg →
//   dedup por session.id falhava. Por msg_id é único por mensagem.
//
// CLAIM-AND-ACT (FASE 2): handler marca marker ANTES de postar.
//   Se POST falha, handler deleta marker → cron pode retry.
//   Cron usa MESMA estratégia: marker pré-claim, post, confirm OR delete-and-skip.

import { list, put, del } from '@vercel/blob';

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

// FASE 2 Item 5: dedup_key prefere chatwoot_message_id sobre session.id
function getDedupKey(sessionId, chatwootMessageId) {
  return chatwootMessageId ? `msg_${chatwootMessageId}` : `sess_${sessionId}`;
}

async function alreadyPosted(dedupKey) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return false;
  try {
    const { blobs } = await list({ prefix: `${BLOB_PREFIX}${dedupKey}` });
    return blobs.length > 0;
  } catch {
    return false;
  }
}

async function markPosted(dedupKey, payload) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    await put(`${BLOB_PREFIX}${dedupKey}.json`, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true, // claim→confirmed transition needs overwrite
      contentType: 'application/json',
    });
  } catch (err) {
    console.error(`[BIA-POSTBACK-MARK] put failed ${dedupKey}: ${err?.message || err}`);
  }
}

// FASE 2 Item 1: delete marker quando POST Chatwoot falha (cron retry no próximo tick)
async function deleteMarker(dedupKey) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const { blobs } = await list({ prefix: `${BLOB_PREFIX}${dedupKey}` });
    for (const b of blobs) {
      await del(b.url);
    }
  } catch (err) {
    console.error(`[BIA-POSTBACK-DEL] failed ${dedupKey}: ${err?.message || err}`);
  }
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
      // FASE 2 Item 5: dedup_key prefere chatwoot_message_id do metadata da session.
      // Handler salva no metadata quando cria session com source=chatwoot_webhook.
      const incomingMsgId = s.metadata?.chatwoot_message_id;
      const dedupKey = getDedupKey(sid, incomingMsgId);
      try {
        // DEDUP: handler já postou? (verifica marker pré ou pós claim)
        if (await alreadyPosted(dedupKey)) {
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
        // FASE 2 Item 1: CLAIM-AND-ACT — marca marker ANTES de postar
        // Re-check dedup uma última vez (race window minimal)
        if (await alreadyPosted(dedupKey)) {
          stats.skipped_already += 1;
          continue;
        }
        await markPosted(dedupKey, {
          session_id: sid,
          conv_id: convId,
          chatwoot_msg_id: null, // será atualizado pós-POST
          chatwoot_message_id_incoming: incomingMsgId || null,
          dedup_key: dedupKey,
          posted_at: new Date().toISOString(),
          posted_by: 'cron_fallback_claiming',
        });
        try {
          const posted = await postChatwoot(convId, clean);
          // POST sucesso — confirma marker com msg_id real
          await markPosted(dedupKey, {
            session_id: sid,
            conv_id: convId,
            chatwoot_msg_id: posted.id,
            chatwoot_message_id_incoming: incomingMsgId || null,
            dedup_key: dedupKey,
            posted_at: new Date().toISOString(),
            posted_by: 'cron_fallback_confirmed',
          });
          stats.posted += 1;
          stats.details.push({ sid: sid.slice(-12), conv: convId, msg_id: posted.id, dedup_key: dedupKey });
        } catch (postErr) {
          // POST falhou — DELETA marker pra próximo cron tick retry
          await deleteMarker(dedupKey);
          stats.errors += 1;
          stats.details.push({ sid: sid.slice(-12), error: String(postErr?.message || postErr).slice(0, 150), marker_deleted: true });
        }
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
