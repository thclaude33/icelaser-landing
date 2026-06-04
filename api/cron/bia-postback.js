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
import { shouldSendNow } from '../_lib/send-window.js';
import { markBiaOutgoing, armCascade, buildSnapshotFromContext } from '../_lib/cascade.js';
import { setActiveSession } from '../_lib/session-reuse.js';
import { skipIfNotPrimary } from '../_lib/primary-project.js';
import { responseOrFallbackFromEvents } from '../_lib/bia-client-response.js';
import { getRecentCtwaContextForPhone } from '../_lib/followup-ctwa.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://chatwoot-production-af5f.up.railway.app';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';

const BLOB_PREFIX = 'bia/postback/posted/';
// FIX V4.1 (Codex C3): 35min = TTL session 30min (session-reuse.js:25) + 5min margem
// latência cron/processamento. Antes 10min perdia respostas Bia quando cliente
// respondia 11-30min depois (gap session-reuse vs postback lookback).
const LOOKBACK_MIN = 35;
const MAX_PER_RUN = 15;
const ANTHROPIC_FETCH_TIMEOUT_MS = 10000;
const CHATWOOT_POST_TIMEOUT_MS = 10000;

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

export async function fetchAnthropic(path, timeoutMs = ANTHROPIC_FETCH_TIMEOUT_MS) {
  const resp = await fetch(`${ANTHROPIC_BASE}${path}`, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY_ICELASER,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`Anthropic ${path} HTTP ${resp.status}`);
  return resp.json();
}

// PROMPT 4 FIX dedup BUG (16/05/2026): dedup_key usa agent.message event idx (único por turno).
// Em session REUSE, session.metadata.chatwoot_message_id é STALE (turno 1 imutável).
// Antes: cron-postback alreadyPosted('msg_<turno1>')=true em turno N → skip → resposta nunca
// postada Chatwoot (perdida na conv Damiane 538 turno 3 "Qual tempo do tratamento?").
// Agora: agent_<sid>_<idx> único por turno cold + reuse. Mesma fórmula handler usa.
function getDedupKey(sessionId, agentMsgEventIdx) {
  if (agentMsgEventIdx !== null && agentMsgEventIdx !== undefined && agentMsgEventIdx >= 0) {
    return `agent_${sessionId}_${agentMsgEventIdx}`;
  }
  return `sess_${sessionId}`; // fallback raro
}

async function alreadyPosted(dedupKey) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return false;
  try {
    const { blobs } = await list({ prefix: `${BLOB_PREFIX}${dedupKey}` });
    return blobs.length > 0;
  } catch (err) {
    // FASE PRÉ-3 Fix #10: log Blob errors
    console.error(`[BIA-POSTBACK-DEDUP] check failed for ${dedupKey}: ${err?.message || err}`);
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

export async function postChatwoot(convId, content, timeoutMs = CHATWOOT_POST_TIMEOUT_MS) {
  const resp = await fetch(
    `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${convId}/messages`,
    {
      method: 'POST',
      headers: { 'api_access_token': process.env.CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, message_type: 'outgoing' }),
      signal: AbortSignal.timeout(timeoutMs),
    }
  );
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Chatwoot ${resp.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  // Multi-projeto race guard (16/05/2026 — cron roda 1×/min × 3 projetos = 4320 invocações/dia.
  // Claim-and-act blob protege contra POST duplicado, mas Anthropic list+filter ANTES do claim
  // queimava custo $$$ recorrente. Apenas primary project executa.).
  if (skipIfNotPrimary(res, 'bia-postback')) return;

  if (!process.env.ANTHROPIC_API_KEY_ICELASER) return res.status(500).json({ error: 'missing_env' });
  if (!process.env.CHATWOOT_API_TOKEN) return res.status(500).json({ error: 'missing_env_chatwoot' });

  const stats = {
    scanned: 0,
    posted: 0,
    fallback_posted: 0,
    blocked_internal_content: 0,
    skipped_already: 0,
    skipped_processing: 0,
    skipped_no_content: 0,
    errors: 0,
    details: [],
  };
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
      const incomingMsgId = s.metadata?.chatwoot_message_id; // mantido pra audit log (não usado em dedup novo)
      try {
        // PROMPT 4 FIX (16/05): dedup PRECISA conhecer agent.message event idx ANTES de checar.
        // Antes: dedup via metadata.chatwoot_message_id STALE em reuse → skipped_already em turno N.
        // Agora: fetch events PRIMEIRO, identifica last agent.message não-meta, deriva dedup_key.
        const ev = await fetchAnthropic(`/sessions/${sid}/events?limit=100`);
        const events = ev.data || [];
        const hasIdle = events.some((e) => e.type === 'session.status_idle');
        if (!hasIdle) {
          stats.skipped_processing += 1;
          continue;
        }
        // Cron postback has no inline baseline for reused sessions. Prefer the latest safe
        // agent response after filtering internals so we do not retry a stale old turn.
        const extracted = responseOrFallbackFromEvents(events, { preferSafeCandidate: 'last' });
        if (!extracted.ok || !extracted.text) {
          stats.skipped_no_content += 1;
          continue;
        }
        if (extracted.fallback) {
          stats.blocked_internal_content += 1;
          stats.details.push({
            sid: sid.slice(-12),
            conv: convId,
            action: 'safe_fallback_for_blocked_internal_content',
            reason: extracted.blockedReason,
          });
        }
        const clean = stripWhatsAppMarkdown(extracted.text);
        if (!clean) {
          stats.skipped_no_content += 1;
          continue;
        }
        // PROMPT 4 FIX (16/05): dedup_key agora baseado em agent.message event idx (único por turno)
        // ao invés de metadata.chatwoot_message_id (STALE em session reuse). Resolve bug Damiane 538.
        const dedupKey = getDedupKey(sid, extracted.agentMsgIdx);
        if (await alreadyPosted(dedupKey)) {
          stats.skipped_already += 1;
          continue;
        }
        // FASE PRÉ-3 ITEM C — Gate janela horária (08:00-20:30 BRT).
        // Lê session_type do metadata. reactive_reply sempre passa.
        const sessionType = s.metadata?.session_type || 'reactive_reply'; // legacy default
        const windowGate = shouldSendNow({ session_type: sessionType });
        if (!windowGate.ok) {
          stats.details.push({ sid: sid.slice(-12), skipped_window: windowGate.reason, next: windowGate.next_send_at });
          continue;
        }
        // FASE 2 Item 1: CLAIM-AND-ACT — marca marker ANTES de postar
        await markPosted(dedupKey, {
          session_id: sid,
          conv_id: convId,
          chatwoot_msg_id: null, // será atualizado pós-POST
          chatwoot_message_id_incoming: incomingMsgId || null,
          agent_msg_idx: extracted.agentMsgIdx,
          agent_msg_preview: extracted.text.slice(0, 200),
          extraction_source: extracted.source || null,
          fallback: extracted.fallback === true,
          blocked_reason: extracted.blockedReason || null,
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
            agent_msg_idx: extracted.agentMsgIdx,
            agent_msg_preview: extracted.text.slice(0, 200),
            extraction_source: extracted.source || null,
            fallback: extracted.fallback === true,
            blocked_reason: extracted.blockedReason || null,
            dedup_key: dedupKey,
            posted_at: new Date().toISOString(),
            posted_by: 'cron_fallback_confirmed',
          });
          // PROMPT 2 — markBiaOutgoing + ARM cascade (mesma lógica handler inline)
          try { await markBiaOutgoing(convId); }
          catch (e) { console.error(`[FU-MARK-BIA-CRON] conv=${convId} ${e?.message || e}`); }
          // PROMPT 4 — refresh TTL session ativa (renova 30min após cron-postback posta msg Bia)
          try { await setActiveSession(convId, sid); }
          catch (e) { console.error(`[SESSION-REUSE-CRON] conv=${convId} ${e?.message || e}`); }
          if (process.env.FOLLOWUP_ENABLED === '1') {
            try {
              const senderName = s.metadata?.sender_name || null;
              const telefone = s.metadata?.telefone || null;
              const snapshot = buildSnapshotFromContext(senderName, clean);
              snapshot.telefone = telefone;
              const ctwa = await getRecentCtwaContextForPhone(telefone);
              snapshot.is_ctwa = ctwa.is_ctwa === true;
              if (ctwa.template_free_until_at) snapshot.template_free_until_at = ctwa.template_free_until_at;
              await armCascade(convId, sid, snapshot);
            } catch (e) {
              console.error(`[FU-ARM-CRON] conv=${convId} ${e?.message || e}`);
            }
          }
          stats.posted += 1;
          if (extracted.fallback) stats.fallback_posted += 1;
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
