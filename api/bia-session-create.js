// api/bia-session-create.js
// P9.7 — Cria session Anthropic Managed Agents (Bia Coordinator + 4 memory stores).
//
// Aceita 2 formatos:
//   A) DIRECT API: { telefone, mensagem_cliente, chatwoot_thread_id? }
//   B) CHATWOOT WEBHOOK: payload flat { event, conversation, sender, content, ... }
//
// LATENCY MODE (cravado 13/05/2026):
//   Path Chatwoot webhook → faz polling INLINE síncrono (2s tick) até Bia
//   responder OU timeout 45s. Quando resposta vem → posta no Chatwoot
//   imediatamente (outgoing → WhatsApp Cloud entrega cliente).
//   Se timeout 45s → retorna 202 (Bia continua processando, cron postback
//   pega depois como fallback).
//
// Filtros Shadow Mode (Chatwoot path):
//   - event === 'message_created'
//   - message_type === 'incoming'
//   - inbox.id === SHADOW_INBOX_ID (default 7)
//   - conversation.labels contém SHADOW_LABEL (default 'bia_teste')
//
// Auth Chatwoot: ?auth=<CHATWOOT_WEBHOOK_QUERY_TOKEN>
//
// DEDUP CRON FALLBACK: quando handler posta com sucesso inline, marca
// `bia/postback/posted/{session_id}.json` no Vercel Blob. Cron bia-postback
// checa esse marker antes de postar — zero duplicação.

import { list, put, del } from '@vercel/blob';
import { sanitizeHeader } from './_lib/security.js';
import { shouldSendNow } from './_lib/send-window.js';
import { kvClaim, kvRelease } from './_lib/kv-rate-limit.js';
import { armCascade, disarmCascade, markBiaOutgoing, buildSnapshotFromContext } from './_lib/cascade.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const COORDINATOR_AGENT_ID = 'agent_018zZxrjHftuiePCuJEUNTqL'; // Coord v18 Sonnet 4.6 + LATENCY HARD
const ENV_ID = 'env_01ANo8eEPnZ3P51da4TQz2HR';

const KB_MASTER = 'memstore_01QLnM9ZTBG1U4WMKT7J19x6';
const BIA_LEARNINGS = 'memstore_017a67p42zpRC97fiXdvZjtX';
const BIA_LEAD_PROFILES = 'memstore_01SgUbvr1THw4X5fZHr4SRan';
const BIA_AUDIT_LOG = 'memstore_014QBMrxVyhm2u2P3x3MzvGr';

const SHADOW_INBOX_ID = parseInt(process.env.BIA_SHADOW_INBOX_ID || '7', 10);
const SHADOW_LABEL = process.env.BIA_SHADOW_LABEL || 'bia_teste';
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://chatwoot-production-af5f.up.railway.app';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';

const POLLING_TICK_MS = 2000; // 2s entre polls
// FASE 1 Item 4 (15/05/2026): 45 → 55s. Vercel maxDuration handler é 60s → sobra 5s pra POST+return.
// Reduz cron-fallback rate de ~22% pra ~5% (msgs Bia entre 45-55s agora pegam dentro do handler).
const POLLING_TIMEOUT_MS = 55000;

// FASE 1 Item 3 (15/05/2026): alerta crítico rate-limited (bucket 4h)
// Evita spam de email/SMTP — max 6 alertas/dia se incidente prolongado.
const ALERT_BUCKET_MS = 14400000; // 4h
const ALERT_BLOB_PREFIX = 'bia/alerts/';

function buildAnthropicHeaders() {
  return {
    'x-api-key': process.env.ANTHROPIC_API_KEY_ICELASER,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'managed-agents-2026-04-01',
    'content-type': 'application/json',
  };
}

// FASE 1 Item 3 — Alerta crítico com dedup bucket 4h via Blob marker.
// Bloqueia email spam se env ficar vazia por horas. Loga também no audit-log
// Anthropic pra rastreabilidade independente do email.
async function sendCriticalAlertOnce(envName, message) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.warn('[BIA-ALERT] BLOB_READ_WRITE_TOKEN não setado — alert skipped');
    return;
  }
  const bucket_4h = Math.floor(Date.now() / ALERT_BUCKET_MS);
  const blobKey = `${ALERT_BLOB_PREFIX}auth_${envName}_${bucket_4h}.json`;
  try {
    const { blobs } = await list({ prefix: blobKey });
    if (blobs.length > 0) {
      console.log(`[BIA-ALERT] suppressed (bucket=${bucket_4h} already sent for ${envName})`);
      return;
    }
    // Marca Blob ANTES de enviar email — se email falha, ainda evita re-spam
    await put(blobKey, JSON.stringify({
      sent_at: new Date().toISOString(),
      bucket_4h,
      env_missing: envName,
      message,
    }), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });

    // Email + audit-log paralelos, ambos com catch (alerta não pode quebrar handler)
    await Promise.allSettled([
      sendBiaCriticalEmail(envName, message),
      logAuditAlert(envName, message),
    ]);
  } catch (err) {
    console.error(`[BIA-ALERT] error: ${err?.message || err}`);
  }
}

async function sendBiaCriticalEmail(envName, message) {
  if (!process.env.EMAIL_PASS) {
    console.warn('[BIA-ALERT-EMAIL] EMAIL_PASS não setado — email skipped');
    return;
  }
  try {
    const nodemailer = (await import('nodemailer')).default;
    const EMAIL_FROM = process.env.EMAIL_FROM || 'espacoicelaserrecife2@gmail.com';
    const EMAIL_TO = (process.env.EMAIL_TO || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');
    const t = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_FROM, pass: process.env.EMAIL_PASS } });
    await t.sendMail({
      from: `"IceLaser Bia Alert" <${EMAIL_FROM}>`,
      to: EMAIL_TO.join(','),
      subject: sanitizeHeader(`[BIA CRITICAL] Auth failure — ${envName}`, 200),
      html: `
        <h2>🚨 BIA CRITICAL Auth Failure</h2>
        <p><b>Env missing:</b> <code>${envName}</code></p>
        <p><b>Timestamp:</b> ${new Date().toISOString()}</p>
        <p><b>Message:</b> ${message}</p>
        <h3>Impacto</h3>
        <ul>
          <li>Webhooks Chatwoot REJEITADOS com 503</li>
          <li>Bia OFFLINE em shadow mode até env ser restaurada</li>
          <li>Leads V9 ativos ficam SEM resposta automática</li>
        </ul>
        <h3>Ação requerida</h3>
        <ol>
          <li><code>cd landing-page && vercel env ls</code> — verificar ${envName}</li>
          <li>Re-adicionar nos 3 projetos Vercel: landing-page, icelaser-landing, icelaser-landing-c9in</li>
          <li>Redeploy: <code>git push main</code> (auto-deploy 3 projetos)</li>
        </ol>
        <hr>
        <small>Alert rate-limited: 1 a cada 4h (bucket=${Math.floor(Date.now() / ALERT_BUCKET_MS)}).</small>
      `,
    });
    console.log(`[BIA-ALERT-EMAIL] sent to ${EMAIL_TO.length} recipients for ${envName}`);
  } catch (err) {
    console.error(`[BIA-ALERT-EMAIL] error: ${err?.message || err}`);
  }
}

async function logAuditAlert(envName, message) {
  // Rastreabilidade independente: grava em audit-log Anthropic memory store
  try {
    const now = new Date();
    const datePath = now.toISOString().slice(0, 10);            // 2026-05-15
    const timePath = now.toISOString().slice(11, 19).replace(/:/g, ''); // 015303
    const path = `/alerts/${datePath}/${timePath}_${envName}.md`;
    const content = [
      `# BIA AUTH FAILURE — ${envName}`,
      ``,
      `**Timestamp**: ${now.toISOString()}`,
      `**Env missing**: \`${envName}\``,
      `**Bucket 4h**: ${Math.floor(Date.now() / ALERT_BUCKET_MS)}`,
      ``,
      `## Message`,
      message,
      ``,
      `## Impact`,
      `- Webhooks Chatwoot REJECTED com 503`,
      `- Bia OFFLINE para shadow mode até env restaurada`,
      ``,
      `## Action`,
      `1. \`vercel env ls\` — verificar ${envName} presente nos 3 projetos`,
      `2. \`vercel env add ${envName}\` (re-adicionar)`,
      `3. \`git push main\` (redeploy auto 3 projetos)`,
    ].join('\n');

    const headers = {
      'x-api-key': process.env.ANTHROPIC_API_KEY_ICELASER,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
      'content-type': 'application/json',
    };
    const resp = await fetch(`${ANTHROPIC_BASE}/memory_stores/${BIA_AUDIT_LOG}/memories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, content }),
    });
    if (!resp.ok) {
      console.error(`[BIA-ALERT-AUDIT] HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    } else {
      console.log(`[BIA-ALERT-AUDIT] logged ${path}`);
    }
  } catch (err) {
    console.error(`[BIA-ALERT-AUDIT] error: ${err?.message || err}`);
  }
}

// FASE 1 Item 3 — FAIL CLOSED + critical alert quando env vazia.
// Bug anterior FAIL OPEN: env vazia retornava ok=true → webhook aceito sem auth.
// Aconteceu na vida real: HMAC stale 27d → webhooks rejeitados silenciosamente.
async function checkAuth(req) {
  const expected = process.env.CHATWOOT_WEBHOOK_QUERY_TOKEN;
  if (!expected) {
    const msg = `CHATWOOT_WEBHOOK_QUERY_TOKEN env missing — webhooks rejeitados desde ${new Date().toISOString()}`;
    console.error(`[BIA-AUTH] CRITICAL: ${msg}`);
    // Fire-and-forget — alerta não bloqueia rejeição
    sendCriticalAlertOnce('CHATWOOT_WEBHOOK_QUERY_TOKEN', msg).catch(() => {});
    return { ok: false, mode: 'env_missing_fail_closed', http: 503 };
  }
  const queryAuth = req.query?.auth || '';
  const headerAuth = req.headers?.['x-webhook-token'] || '';
  if (queryAuth === expected || headerAuth === expected) {
    return { ok: true, mode: 'query_token' };
  }
  return { ok: false, mode: 'missing_or_invalid', http: 401 };
}

function isChatwootPayload(body) {
  return typeof body?.event === 'string' && !body.mensagem_cliente;
}

function normalizeChatwoot(body) {
  const event = body.event;
  const messageType = body.message_type;

  if (event !== 'message_created') return { skip: true, reason: 'event_not_message_created', event };

  const isIncoming = messageType === 'incoming' || messageType === 0;
  if (!isIncoming) return { skip: true, reason: 'message_not_incoming', message_type: messageType };

  const inboxId = body.inbox?.id ?? body.conversation?.inbox_id ?? body.inbox_id;
  if (Number(inboxId) !== SHADOW_INBOX_ID) {
    return { skip: true, reason: 'inbox_not_shadow', inbox_id: inboxId, expected: SHADOW_INBOX_ID };
  }

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

  if (body.private === true) return { skip: true, reason: 'private_note' };

  const content = String(body.content || '').trim();
  if (!content) return { skip: true, reason: 'empty_content' };

  const phone = body.sender?.phone_number || body.conversation?.meta?.sender?.phone_number || body.contact?.phone_number || '';
  const telefone = String(phone || '').replace(/^\+/, '').replace(/\D/g, '');
  if (!telefone) return { skip: true, reason: 'no_phone_number' };

  return {
    skip: false,
    telefone,
    mensagem_cliente: content,
    chatwoot_thread_id: body.conversation?.id ?? body.conversation_id ?? null,
    sender_name: body.sender?.name || body.conversation?.meta?.sender?.name || null,
    chatwoot_message_id: body.id ?? null,
  };
}

function stripWhatsAppMarkdown(text) {
  return String(text || '')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*') // **bold** → *bold* (WA suporta)
    .replace(/^---+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// FASE PRÉ-3 Fix #2/#4 — extractClientResponse simplificado.
// Bug histórico: regex anterior pegava bloco errado quando Bia gerava multi-block
// response (ex: msg 5441 conv 510 — cliente perguntou "meia perna" recebeu apenas
// bloco "recorrência"). Causa raiz: regex match parcial em palavras como "IceLaser".
// Fix: retornar texto completo. stripWhatsAppMarkdown remove "---" separadores.
function extractClientResponse(text) {
  if (!text) return null;
  return text.trim();
}

// BUG #32 mitigation (15/05/2026) — Coord v36 PROFILE WRITE STUB MANDATORY induziu
// regressão: Bia emitia "Profile criado ✅" como agent.message DEPOIS do tool_use de
// write profile. Handler post-tool_use boundary pegava essa meta-confirmação ao invés
// da resposta cliente real. Coord v37 PATCH instrui Bia a parar após tool_use, mas
// defense-in-depth: handler também filtra essas meta-confirmações curtas.
function isMetaConfirmation(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length >= 80) return false;
  // Padrão: "Profile/Perfil ... criado/salvo/confirmado/atualizado/registrado/anotado"
  return /^(profile|perfil)[^\n]{0,40}(criad|salv|confirm|atualiz|registrad|anotad|escrit)/i.test(t);
}

async function fetchAnthropic(path) {
  const resp = await fetch(`${ANTHROPIC_BASE}${path}`, { headers: buildAnthropicHeaders() });
  if (!resp.ok) throw new Error(`Anthropic ${path} HTTP ${resp.status}`);
  return resp.json();
}

async function pollSessionForResponse(sessionId, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const data = await fetchAnthropic(`/sessions/${sessionId}/events?limit=100`);
    const events = data.data || [];
    const hasIdle = events.some((e) => e.type === 'session.status_idle');
    const hasError = events.some((e) => e.type === 'session.error');
    if (hasError) return { ready: false, error: 'session.error' };
    if (hasIdle) {
      // FASE PRÉ-3 Fix #1 + BUG #32 mitigation (v37):
      // Estratégia 3 camadas:
      //   A) Coord v37 instrui Bia a NÃO emitir agent.message após tool_use profile write
      //   B) Filtra meta-confirmações curtas (isMetaConfirmation) no boundary post-tool_use
      //   C) Fallback: maior agent.message do turno (filtra meta) — vence se A+B falham
      const agentMsgs = events
        .filter((e) => e.type === 'agent.message')
        .map((e) => {
          const c = (e.content || []).find((x) => x.type === 'text' && x.text);
          return { text: c?.text || '', idx: events.indexOf(e) };
        })
        .filter((m) => m.text && m.text.length > 0 && !isMetaConfirmation(m.text));

      if (agentMsgs.length === 0) {
        return { ready: false, error: 'no_text_found_but_idle' };
      }

      // Boundary primário: última agent.message não-meta APÓS último tool_use
      let lastToolUseIdx = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'agent.tool_use') { lastToolUseIdx = i; break; }
      }
      const postTool = agentMsgs.filter((m) => m.idx > lastToolUseIdx);
      if (postTool.length > 0) {
        return { ready: true, text: postTool[postTool.length - 1].text };
      }

      // Fallback C: maior msg do turno (resposta real 639 chars vence meta 38 chars)
      const largest = agentMsgs.slice().sort((a, b) => b.text.length - a.text.length)[0];
      return { ready: true, text: largest.text };
    }
    // Não terminou ainda — sleep tick
    await new Promise((r) => setTimeout(r, POLLING_TICK_MS));
  }
  return { ready: false, error: 'timeout' };
}

// CONTEXTO CHATWOOT — busca histórico da conversa pra injetar no prompt
// Resolve Bug #3 (re-apresentação): Bia vê "já me apresentei antes nessa conv"
// e aplica Cenário D (continuação) em vez de Cenário A (saudação completa).
// FASE PRÉ-3 Fix #5 — history limits 20→50 msgs + 250→1500 chars.
// Bia precisa contexto rico pra responder coerente (especialmente Cenário D 24h+).
// Custo extra absorvido por auto-cache 95% hit_rate. ~$0.04-0.06/turn aceitável.
async function fetchChatwootHistory(convId, limit = 50) {
  try {
    const resp = await fetch(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${convId}/messages?page=1`,
      {
        headers: { 'api_access_token': process.env.CHATWOOT_API_TOKEN },
      }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const all = data.payload || [];
    // Filter: só incoming/outgoing texto (skip activity logs / private notes)
    const filtered = all.filter((m) => {
      const t = m.message_type;
      const isText = t === 0 || t === 1 || t === 'incoming' || t === 'outgoing';
      return isText && !m.private && (m.content || '').trim().length > 0;
    });
    // Order ASC by timestamp + limit últimas N (mais recentes ao final)
    filtered.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    const recent = filtered.slice(-limit);
    return recent.map((m) => {
      const mt = m.message_type;
      const role = (mt === 0 || mt === 'incoming') ? 'CLIENTE' : 'BIA';
      const ts = m.created_at ? new Date(m.created_at * 1000).toISOString().slice(11, 16) : '';
      const content = String(m.content || '').replace(/\n/g, ' ').slice(0, 1500);
      return `[${ts}] ${role}: ${content}`;
    });
  } catch (err) {
    // FASE PRÉ-3 Fix #10: log error em vez de silent fail
    console.error(`[BIA-HISTORY] fetch failed conv=${convId}: ${err?.message || err}`);
    return null;
  }
}

async function postChatwootMessage(convId, content) {
  const resp = await fetch(
    `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${convId}/messages`,
    {
      method: 'POST',
      headers: { 'api_access_token': process.env.CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, message_type: 'outgoing' }),
    }
  );
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Chatwoot POST HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

const BLOB_PREFIX = 'bia/postback/posted/';

// FASE 2 Item 5 (15/05/2026): dedup_key prefere chatwoot_message_id (único por msg)
// sobre session.id. Chatwoot retry duplicado abre 2 sessions diferentes — antes
// dedup falhava (key session.id era diferente). Agora msg_id é único por mensagem.
function getDedupKey(sessionId, chatwootMessageId) {
  return chatwootMessageId ? `msg_${chatwootMessageId}` : `sess_${sessionId}`;
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
    console.error(`[BIA-MARK] put failed for ${dedupKey}: ${err?.message || err}`);
  }
}

// FASE 2 Item 1: delete marker quando POST Chatwoot falha — permite cron retry.
async function deleteMarker(dedupKey) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const { blobs } = await list({ prefix: `${BLOB_PREFIX}${dedupKey}` });
    for (const b of blobs) {
      await del(b.url);
    }
  } catch (err) {
    console.error(`[BIA-DEL-MARKER] failed for ${dedupKey}: ${err?.message || err}`);
  }
}

async function alreadyPosted(dedupKey) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return false;
  try {
    const { blobs } = await list({ prefix: `${BLOB_PREFIX}${dedupKey}` });
    return blobs.length > 0;
  } catch (err) {
    // FASE PRÉ-3 Fix #10: log Blob errors (não silent — fail-open mas observável)
    console.error(`[BIA-DEDUP] alreadyPosted check failed for ${dedupKey}: ${err?.message || err}`);
    return false; // fail-open: prefere duplicate-risk vs perder msg
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.ANTHROPIC_API_KEY_ICELASER) {
    return res.status(500).json({ error: 'missing_env', detail: 'ANTHROPIC_API_KEY_ICELASER not set' });
  }

  const rawBody = req.body || {};
  let telefone, mensagem_cliente, chatwoot_thread_id;
  let extra = {};
  let source = 'direct';

  if (isChatwootPayload(rawBody)) {
    source = 'chatwoot_webhook';
    const auth = await checkAuth(req);
    if (!auth.ok) {
      const httpCode = auth.http || 401;
      return res.status(httpCode).json({ error: httpCode === 503 ? 'service_unavailable' : 'unauthorized', detail: auth.mode });
    }
    const normalized = normalizeChatwoot(rawBody);
    if (normalized.skip) {
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
    telefone = String(rawBody.telefone || '').trim();
    mensagem_cliente = String(rawBody.mensagem_cliente || '').trim();
    chatwoot_thread_id = rawBody.chatwoot_thread_id ?? null;
    if (!telefone || !mensagem_cliente) {
      return res.status(400).json({
        error: 'bad_request',
        detail: 'telefone + mensagem_cliente obrigatórios (caminho direct) OU envie payload Chatwoot',
      });
    }
  }

  const t_start = Date.now();
  const headers = buildAnthropicHeaders();

  // PROMPT 2 — DISARM cascade: cliente respondeu (incoming msg recebida).
  // Roda ANTES do KV claim pra garantir desarme imediato mesmo se claim falhar.
  // Fail-open: erro KV log mas não bloqueia handler.
  if (chatwoot_thread_id && source === 'chatwoot_webhook') {
    try { await disarmCascade(chatwoot_thread_id, 'client_replied'); }
    catch (e) { console.error(`[FU-DISARM-ERR] conv=${chatwoot_thread_id} ${e?.message || e}`); }
  }

  // FASE 3.3 (BUG #31 fix) — KV atomic claim substitui Blob pre_msg_X marker.
  // Vercel KV SETNX é ATÔMICO (zero TOCTOU). Blob list+put tinha race window ~50ms.
  // Resultado: handler 100% impede 2 sessions Anthropic em parallel webhooks.
  //
  // Pattern:
  //   - Claim KV `rl:thread:{conv_id}:in_flight` antes POST /sessions Anthropic
  //   - Se ok=false → outro handler já processando esta thread → 429 rate_limit_in_flight
  //   - Se ok=true → segue fluxo, libera KV no finish (success + error paths)
  //   - TTL 90s cobre POLLING 55s + buffer Anthropic + slack
  //
  // Fail-open: se KV indisponível (env missing/timeout), helper retorna ok:true+fallback:true.
  // Handler continua operando degraded (race volta, mas sistema não cai).
  //
  // Fallback: msg sem chatwoot_message_id (direct path) usa telefone como dedup key.
  const kvClaimKey = chatwoot_thread_id
    ? `rl:thread:${chatwoot_thread_id}:in_flight`
    : `rl:phone:${telefone}:in_flight`;
  const kvClaimValue = extra.chatwoot_message_id
    ? `msg_${extra.chatwoot_message_id}`
    : `pre_${Date.now()}`;
  const KV_CLAIM_TTL_SEC = 90;
  const kvClaimResult = await kvClaim(kvClaimKey, kvClaimValue, KV_CLAIM_TTL_SEC);
  if (!kvClaimResult.ok && !kvClaimResult.fallback) {
    return res.status(429).json({
      error: 'rate_limit_in_flight',
      detail: 'Outra requisição já está processando esta thread/telefone',
      claim_key: kvClaimKey,
      existing_claim: kvClaimResult.existing,
      source,
    });
  }
  // FASE 3.3 — kept Blob pre_msg_X marker as SECONDARY dedup (defesa em camadas):
  // KV cobre race in-flight; Blob marker pos-session (msg_X) cobre Chatwoot retry.
  // Removemos APENAS o pre_msg_X claim/check (substituído por KV); msg_X (pós-POST
  // Chatwoot) continua existindo lá embaixo.
  const preSessionDedupKey = null; // legacy — não usado mais (substituído por KV claim)

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
        session_type: 'reactive_reply', // FASE PRÉ-3 ITEM C: prepara gate janela horária
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
      method: 'POST', headers, body: JSON.stringify(sessionPayload),
    });
    const sessText = await sessResp.text();
    if (!sessResp.ok) {
      // FASE PRÉ-3 ITEM B: session create falhou — DELETA marker pré-claim pra cron retry
      if (preSessionDedupKey) await deleteMarker(preSessionDedupKey);
      return res.status(502).json({ error: 'session_create_failed', status: sessResp.status, detail: sessText.slice(0, 500), source });
    }
    const session = JSON.parse(sessText);
    if (!session.id) {
      if (preSessionDedupKey) await deleteMarker(preSessionDedupKey);
      return res.status(502).json({ error: 'session_no_id', detail: sessText.slice(0, 500), source });
    }

    // 2. Buscar histórico Chatwoot (se webhook path) pra Bia ver continuidade da conv
    //    Resolve Bug #3 — Bia detecta "já me apresentei" e aplica Cenário D
    let historico = '';
    if (source === 'chatwoot_webhook' && chatwoot_thread_id) {
      const histLines = await fetchChatwootHistory(chatwoot_thread_id, 20);
      if (histLines && histLines.length > 1) {
        // Remove a última linha (mensagem atual já está no `mensagem_cliente`)
        // pra não duplicar
        const prev = histLines.slice(0, -1);
        if (prev.length > 0) {
          historico = `(HISTÓRICO CONVERSA CHATWOOT — você está em CONTINUAÇÃO, NÃO repita saudação completa, aplique Cenário D do decision tree):\n${prev.join('\n')}\n\n(MENSAGEM ATUAL DO CLIENTE — responde ela):\n`;
        }
      }
    }

    // 3. Enviar msg cliente prefixada com telefone + histórico (se houver)
    const mensagemComPrefixo = `${historico}(TELEFONE_CLIENTE: +${telefone}) ${mensagem_cliente}`;
    const eventPayload = {
      events: [{ type: 'user.message', content: [{ type: 'text', text: mensagemComPrefixo }] }],
    };
    const evResp = await fetch(`${ANTHROPIC_BASE}/sessions/${session.id}/events`, {
      method: 'POST', headers, body: JSON.stringify(eventPayload),
    });
    const evText = await evResp.text();
    if (!evResp.ok) {
      // FASE PRÉ-3 ITEM B: event send falhou — DELETA marker pré-claim pra cron retry
      if (preSessionDedupKey) await deleteMarker(preSessionDedupKey);
      return res.status(502).json({ error: 'event_send_failed', session_id: session.id, status: evResp.status, detail: evText.slice(0, 500), source });
    }

    // 3. SE Chatwoot webhook → polling inline síncrono + posta resposta
    if (source === 'chatwoot_webhook' && chatwoot_thread_id) {
      const deadline = t_start + POLLING_TIMEOUT_MS;
      const result = await pollSessionForResponse(session.id, deadline);
      const elapsed_ms = Date.now() - t_start;

      if (result.ready && result.text) {
        const clientResp = extractClientResponse(result.text);
        const clean = stripWhatsAppMarkdown(clientResp);
        if (clean && clean.length >= 10) {
          // FASE 2 Item 5: dedup_key prefere chatwoot_message_id (único por msg).
          // Chatwoot retry pode abrir 2 sessions → mesmo msg_id → dedup pega.
          const dedupKey = getDedupKey(session.id, extra.chatwoot_message_id);
          try {
            // RE-CHECK dedup right before posting
            if (await alreadyPosted(dedupKey)) {
              return res.status(200).json({
                success: true,
                source,
                session_id: session.id,
                dedup_key: dedupKey,
                already_posted: true,
                elapsed_ms,
              });
            }
            // FASE PRÉ-3 ITEM C — Gate janela horária (08:00-20:30 BRT).
            // session_type='reactive_reply' sempre passa (cliente esperando).
            // Outros tipos (proactive_followup) bloqueia fora janela.
            const windowGate = shouldSendNow({ session_type: 'reactive_reply' });
            if (!windowGate.ok) {
              console.warn(`[BIA-WINDOW] blocked session=${session.id} reason=${windowGate.reason}`);
              return res.status(202).json({
                ok: true,
                source,
                session_id: session.id,
                warning: 'blocked_outside_send_window',
                reason: windowGate.reason,
                next_send_at: windowGate.next_send_at,
                elapsed_ms,
              });
            }
            // FASE 2 Item 1: CLAIM-AND-ACT — marca marker ANTES de postar.
            // Bloqueia race com cron-postback que checa marker entre POST e markPosted.
            // Se POST falhar, deleta marker pra permitir cron retry.
            await markPosted(dedupKey, {
              session_id: session.id,
              conv_id: chatwoot_thread_id,
              chatwoot_msg_id: null, // será atualizado pós-POST
              chatwoot_message_id_incoming: extra.chatwoot_message_id || null,
              dedup_key: dedupKey,
              posted_at: new Date().toISOString(),
              posted_by: 'handler_inline_claiming',
              elapsed_ms,
            });
            try {
              const posted = await postChatwootMessage(chatwoot_thread_id, clean);
              // POST sucesso — confirma marker com msg_id real
              await markPosted(dedupKey, {
                session_id: session.id,
                conv_id: chatwoot_thread_id,
                chatwoot_msg_id: posted.id,
                chatwoot_message_id_incoming: extra.chatwoot_message_id || null,
                dedup_key: dedupKey,
                posted_at: new Date().toISOString(),
                posted_by: 'handler_inline_confirmed',
                elapsed_ms,
              });
              // PROMPT 2 — markBiaOutgoing (anti-collision com webhook humana detect)
              try { await markBiaOutgoing(chatwoot_thread_id); }
              catch (e) { console.error(`[FU-MARK-BIA] conv=${chatwoot_thread_id} ${e?.message || e}`); }
              // PROMPT 2 — ARMA cascade follow-up (4min próxima msg F1 step 0)
              if (process.env.FOLLOWUP_ENABLED === '1') {
                try {
                  const snapshot = buildSnapshotFromContext(extra.sender_name, clean);
                  await armCascade(chatwoot_thread_id, session.id, snapshot);
                } catch (e) {
                  console.error(`[FU-ARM-ERR] conv=${chatwoot_thread_id} ${e?.message || e}`);
                }
              }
              return res.status(200).json({
                success: true,
                source,
                session_id: session.id,
                dedup_key: dedupKey,
                chatwoot_msg_id: posted.id ?? null,
                elapsed_ms,
                resources_attached: session.resources?.length ?? null,
              });
            } catch (postErr) {
              // POST falhou — DELETA marker pra cron poder retry
              await deleteMarker(dedupKey);
              console.warn(`[BIA-CLAIM] post failed, marker deleted for ${dedupKey}: ${postErr?.message || postErr}`);
              return res.status(200).json({
                success: true,
                source,
                session_id: session.id,
                dedup_key: dedupKey,
                warning: 'response_ready_but_chatwoot_post_failed',
                detail: String(postErr?.message || postErr),
                marker_deleted: true,
                elapsed_ms,
              });
            }
          } catch (claimErr) {
            // Falha no claim — log + cron pega depois
            console.error(`[BIA-CLAIM] claim failed for ${dedupKey}: ${claimErr?.message || claimErr}`);
            return res.status(200).json({
              success: true,
              source,
              session_id: session.id,
              warning: 'claim_failed_cron_will_pickup',
              detail: String(claimErr?.message || claimErr),
              elapsed_ms,
            });
          }
        }
      }

      // Timeout ou no_text — retorna 202, deixa cron fallback pegar
      return res.status(202).json({
        ok: true,
        source,
        session_id: session.id,
        warning: 'response_not_ready_in_window',
        reason: result.error || 'unknown',
        elapsed_ms,
        note: 'cron bia-postback fallback will deliver when ready',
      });
    }

    // Caminho A direct — retorna info da session (sem polling)
    let event;
    try { event = JSON.parse(evText); } catch { event = { raw: evText.slice(0, 200) }; }
    return res.status(200).json({
      success: true,
      source,
      session_id: session.id,
      event_id: event?.data?.[0]?.id ?? event?.id ?? null,
      resources_attached: session.resources?.length ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'unhandled', detail: String(err?.message || err), source });
  } finally {
    // FASE 3.3 — release KV claim em TODA saída (success, error, exception).
    // Garante que a key não fica "presa" por 90s bloqueando reentrada legítima.
    // kvRelease é idempotent (DEL no-op se não existe).
    try { await kvRelease(kvClaimKey); }
    catch (e) { console.error(`[KV-RELEASE-FINALLY] ${kvClaimKey}: ${e?.message || e}`); }
  }
}
