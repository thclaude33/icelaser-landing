/**
 * /api/log-drain — Receptor de Vercel Drains (Logs)
 *
 * Docs oficiais (18/04/2026):
 *  - https://vercel.com/docs/drains                — overview (Logs, Traces, Speed Insights, Analytics)
 *  - https://vercel.com/docs/drains/reference/logs — schema completo + sources + environments
 *  - https://vercel.com/docs/drains/security       — HMAC-SHA1 signature + IP visibility
 *  - https://vercel.com/docs/headers/request-headers#x-vercel-signature
 *
 * Pipeline (ordem importa):
 *   1. x-vercel-verify header em TODA resposta (endpoint verification handshake).
 *   2. GET /api/log-drain → 200 "ok" (initial verify + manual test via dashboard).
 *   3. POST → verifica HMAC-SHA1(rawBody, LOG_DRAIN_SECRET) vs x-vercel-signature
 *      (constant-time comparison; fail-closed).
 *   4. Persiste rawBody no Vercel Blob (PRIVATE, cache 0) com nome hash-suffixed.
 *   5. Retorna 200 OK (Vercel marca drain como errored se >80% falhas / >50/hora).
 *
 * Escolhas de design:
 *   - access:'public' (store Vercel Blob é public, private lança runtime error).
 *     Segurança: addRandomSuffix gera URL não-adivinhável como bearer token.
 *   - addRandomSuffix:true evita overwrite em batches simultâneos.
 *   - cacheControlMaxAge:0 — logs não precisam CDN cache (acessados só auditoria).
 *   - Blob errors retornam 200 (best-effort; Vercel não retry forever; se retornar
 *     5xx gera noise no drain errored dashboard que não ajuda com erro transient).
 *   - getRawBody custom com MAX_BODY_SIZE (5 MB) pra prevenir OOM em payloads anômalos.
 *   - x-vercel-signature pode vir como array (HTTP duplicate header). Normaliza pra string.
 */

import crypto from 'crypto';
import { put } from '@vercel/blob';

// Vercel Node runtime default body limit é 4.5MB. Batches drain típicos <1MB,
// mas picos (burst traffic) podem exceder. Aceita até 5MB antes de rejeitar.
const MAX_BODY_SIZE = 5 * 1024 * 1024;

// Timeout do put() — maxDuration da func é 10s; dar até 7s pro Blob + margem.
const BLOB_TIMEOUT_MS = 7000;

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_SIZE) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// HTTP headers em Node podem vir como string | string[] | undefined.
// `x-vercel-signature` é sempre 1 header, mas defensive: pegar primeiro valor.
function firstHeader(h) {
  if (Array.isArray(h)) return h[0] || '';
  return typeof h === 'string' ? h : '';
}

// Wrap put() com timeout — evita funcExec timeout quando Blob API está lenta.
async function putWithTimeout(fileName, body, opts) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), BLOB_TIMEOUT_MS);
  try {
    return await put(fileName, body, { ...opts, abortSignal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

export default async function handler(req, res) {
  // 1. x-vercel-verify em TODA resposta.
  // Valor oficial do Vercel team (data source: vercel_endpoint_verification_code).
  // Hardcoded fallback pro valor atual IceLaser (13/04/2026) — se rotacionar,
  // setar VERCEL_LOG_DRAIN_VERIFY env var sem redeploy.
  // Sem este header, Vercel rejeita handshake inicial + re-validação.
  const verifyToken = process.env.VERCEL_LOG_DRAIN_VERIFY
    || 'dc04cc178d4addf38b1a252e26f92b0f7b1d0f64';
  res.setHeader('x-vercel-verify', verifyToken);

  if (req.method === 'GET' || req.method === 'HEAD') {
    // Initial verification handshake + manual "Test" button do dashboard.
    // Vercel NÃO assina esse request (doc oficial).
    return res.status(200).json({ ok: true, service: 'log-drain', method: req.method });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // 2. Lê raw body com limite. Qualquer erro vira 400 (client error, Vercel não retry).
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.warn('[LOG-DRAIN] getRawBody failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  // 3. Verifica assinatura HMAC-SHA1 (fail-closed).
  const secret = process.env.LOG_DRAIN_SECRET;
  if (!secret) {
    console.error('[LOG-DRAIN] LOG_DRAIN_SECRET ausente — não é possível validar');
    // 403 (não 500) porque é config do nosso lado, não crash. Vercel retry 5xx
    // mas NÃO 4xx → 403 evita bloat de retry inútil + drain errored flags.
    return res.status(403).json({ error: 'not_configured' });
  }

  const sig = firstHeader(req.headers['x-vercel-signature']);
  const expected = crypto.createHmac('sha1', secret).update(rawBody).digest('hex');

  if (!sig || sig.length !== expected.length) {
    console.warn('[LOG-DRAIN] signature missing or wrong length', { sigLen: sig?.length, expLen: expected.length });
    return res.status(403).json({ error: 'invalid_signature' });
  }

  // timingSafeEqual exige Buffers de tamanho igual — já validamos length acima.
  let equal = false;
  try {
    equal = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    // Chars não-hex em sig viram Buffer com padding diferente — trata como mismatch.
    equal = false;
  }
  if (!equal) {
    console.warn('[LOG-DRAIN] signature mismatch');
    return res.status(403).json({ error: 'invalid_signature' });
  }

  // 4. Observability: conta logs no batch p/ facilitar debug sem ler blob.
  // NDJSON: contar newlines. JSON array: length do array. Silent on parse fail.
  let logCount = 0;
  const bodyStr = rawBody.toString('utf-8');
  const contentType = firstHeader(req.headers['content-type']) || '';
  try {
    if (contentType.includes('ndjson') || bodyStr.includes('\n{')) {
      logCount = bodyStr.split('\n').filter(Boolean).length;
    } else {
      const parsed = JSON.parse(bodyStr);
      logCount = Array.isArray(parsed) ? parsed.length : 1;
    }
  } catch {}

  // 5. Persiste no Blob (se configurado). Falha = 200 com metadata (não retry).
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.log('[LOG-DRAIN] recebido', { bytes: rawBody.length, logs: logCount, storage: 'none' });
    return res.status(200).json({ ok: true, logs: logCount, stored: false });
  }

  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const ts = now.toISOString().replace(/[:.]/g, '-');
    // NDJSON convenção: extension .ndjson pra detecção correta ao ler.
    const isNdjson = contentType.includes('ndjson');
    const ext = isNdjson ? 'ndjson' : 'json';
    const fileName = `logs/${day}/${ts}.${ext}`;

    const blob = await putWithTimeout(fileName, rawBody, {
      // Store Vercel Blob é public — `access:'private'` lança erro runtime.
      // Segurança: addRandomSuffix gera URL não-adivinhável (ex:
      // logs/2026-04-18/2026-04-18T15-30-00-000Z-a1b2c3d4e5f6.ndjson), e o path
      // prefix não é enumerável externamente. Store privado custa extra; o
      // random suffix serve como bearer token no URL.
      access: 'public',
      contentType: isNdjson ? 'application/x-ndjson' : 'application/json',
      addRandomSuffix: true,      // evita overwrite + URL não-adivinhável
      cacheControlMaxAge: 0,      // logs não precisam CDN cache
    });

    console.log('[LOG-DRAIN] ok', { bytes: rawBody.length, logs: logCount, path: blob.pathname });
    return res.status(200).json({ ok: true, logs: logCount, stored: true });
  } catch (err) {
    // Best-effort: loga erro pra Vercel Runtime Logs (self-observable) mas
    // retorna 200 pra não disparar drain-errored (>80% failures / 1h).
    console.error('[LOG-DRAIN] blob_error', { msg: err.message, bytes: rawBody.length, logs: logCount });
    // Fix LOW AI deep v3 (log-drain.js:181): não vazar err.message (pode conter
    // stack path, connection strings) na response. Genérico 'storage_error'.
    return res.status(200).json({ ok: true, logs: logCount, stored: false, error: 'storage_error' });
  }
}
