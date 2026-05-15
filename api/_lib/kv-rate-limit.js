// api/_lib/kv-rate-limit.js
// FASE 3.2 — Helper Vercel KV (Upstash Redis) pra rate limit + atomic claim.
//
// Substitui o pattern Blob marker `pre_msg_X` (commit 6fefb5e) que tem
// race window TOCTOU ~50ms (list → check → put NÃO é atômico).
// Vercel KV REST API expõe SETNX nativo + EXPIRE — atomic 100%.
//
// PATTERNS:
//   1) claim(key, value, ttlSec)        — atomic SETNX (1 only winner)
//   2) release(key)                     — DEL (idempotent)
//   3) get(key)                         — GET (verifica existência/valor atual)
//   4) incrWithExpire(key, ttlSec)      — INCR atomic + EXPIRE first-write (rate limit counter)
//
// USAGE no handler bia-session-create:
//   const claimKey = `rl:thread:${convId}:in_flight`;
//   const claimed = await kvClaim(claimKey, sessionId || 'pre', 90); // 90s = POLLING 55s + buffer
//   if (!claimed.ok) {
//     return res.status(429).json({ error: 'rate_limit_in_flight', existing: claimed.existing });
//   }
//   // ... process ...
//   await kvRelease(claimKey);
//
// ENV VARS (auto-injected pelo Vercel quando KV está connected ao projeto):
//   KV_REST_API_URL       — https://<id>.upstash.io
//   KV_REST_API_TOKEN     — token de acesso (Bearer)
//
// FAIL-OPEN policy: se KV indisponível (missing env, timeout, 5xx), helper
// retorna {ok:true, fallback:true} — handler continua operando (degrade
// gracioso, race condition volta mas sistema não cai). Audit-log via console.
//
// Reusável FUTURE PROMPT 2 (cascade follow-up):
//   fu:thread:{conv_id}:next_step       — número do próximo step (1..N)
//   fu:thread:{conv_id}:scheduled_at    — ISO timestamp próximo send
//   fu:thread:{conv_id}:lock            — claim atômico pra cron worker

const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const KV_TIMEOUT_MS = 3000; // 3s — KV é local-region, deve responder <50ms

function kvAvailable() {
  return Boolean(KV_URL && KV_TOKEN);
}

async function kvFetch(pathParts, opts = {}) {
  if (!kvAvailable()) {
    return { ok: false, status: 0, body: null, error: 'kv_not_configured' };
  }
  // Upstash REST API: path-style args. Ex: SET key val EX 90 NX → /set/key/val/EX/90/NX
  const path = pathParts.map((p) => encodeURIComponent(String(p))).join('/');
  const url = `${KV_URL.replace(/\/$/, '')}/${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KV_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      body: opts.body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await resp.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { ok: resp.ok, status: resp.status, body, error: null };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, status: 0, body: null, error: String(err?.message || err) };
  }
}

/**
 * Atomic claim — SETNX com TTL.
 * Retorna { ok: true } se conseguiu claim, { ok: false, existing: <value> } se já existia.
 * Fail-open: KV indisponível → { ok: true, fallback: true } (handler continua).
 */
export async function kvClaim(key, value, ttlSec = 60) {
  if (!kvAvailable()) {
    console.warn(`[KV-CLAIM] not_configured key=${key} — fallback OK`);
    return { ok: true, fallback: true };
  }
  // Upstash REST: SET key value EX ttl NX
  const r = await kvFetch(['set', key, value, 'EX', ttlSec, 'NX']);
  if (!r.ok) {
    console.error(`[KV-CLAIM] fetch_error key=${key} status=${r.status} err=${r.error}`);
    return { ok: true, fallback: true, error: r.error }; // FAIL OPEN
  }
  // Upstash retorna: { result: "OK" } se claim, { result: null } se já existia
  const result = r.body?.result;
  if (result === 'OK') {
    return { ok: true };
  }
  // Já existia — buscar valor atual pra debug
  const existing = await kvGet(key);
  return { ok: false, existing: existing.value };
}

/**
 * Release claim — DEL idempotent.
 */
export async function kvRelease(key) {
  if (!kvAvailable()) return { ok: true, fallback: true };
  const r = await kvFetch(['del', key]);
  if (!r.ok) {
    console.error(`[KV-RELEASE] fetch_error key=${key} status=${r.status} err=${r.error}`);
    return { ok: false, error: r.error };
  }
  return { ok: true, deleted: r.body?.result || 0 };
}

/**
 * GET key — retorna { ok, value } ou { ok: false } se não existe ou erro.
 */
export async function kvGet(key) {
  if (!kvAvailable()) return { ok: false, fallback: true };
  const r = await kvFetch(['get', key]);
  if (!r.ok) return { ok: false, error: r.error };
  const value = r.body?.result;
  if (value === null || value === undefined) return { ok: false, not_found: true };
  return { ok: true, value };
}

/**
 * Atomic INCR + EXPIRE (set TTL apenas no first-write).
 * Útil pra rate-limit counter (ex: max 5 msgs/60s por thread).
 * Retorna { ok, count }.
 */
export async function kvIncrWithExpire(key, ttlSec = 60) {
  if (!kvAvailable()) return { ok: true, fallback: true, count: 0 };
  // Upstash pipeline atomic: MULTI / INCR / EXPIRE … só EXPIRE se INCR resultou em 1.
  // Workaround REST: INCR (atomic) + EXPIRE NX (set only if no TTL — Upstash 7.4+).
  const incr = await kvFetch(['incr', key]);
  if (!incr.ok) {
    console.error(`[KV-INCR] fetch_error key=${key} err=${incr.error}`);
    return { ok: true, fallback: true, count: 0, error: incr.error };
  }
  const count = Number(incr.body?.result || 0);
  if (count === 1) {
    // Primeira chamada — set TTL
    await kvFetch(['expire', key, ttlSec]);
  }
  return { ok: true, count };
}

/**
 * Diagnostic — confirma KV está respondendo (pra startup/health check).
 */
export async function kvPing() {
  if (!kvAvailable()) return { ok: false, configured: false };
  const r = await kvFetch(['ping']);
  return { ok: r.ok, configured: true, pong: r.body?.result, error: r.error };
}
