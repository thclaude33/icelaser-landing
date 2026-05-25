/**
 * /api/pixel — CNAME proxy para Meta Pixel JS
 * Carrega connect.facebook.net/en_US/fbevents.js do dominio icelasers.com.br
 * Resultado: cookies _fbp/_fbc sao first-party verdadeiros (mesmo dominio)
 * Safari ITP nao limita cookies first-party HTTP — persistem 180 dias
 */

import { ALLOWED_ORIGINS } from './_lib/config.js';

const PIXEL_JS_URL = 'https://connect.facebook.net/en_US/fbevents.js';
let cachedScript = null;
let cacheTime = 0;
// Fix LOW AI deep v3 (pixel.js:34): lock concurrent refresh. Antes N requests
// simultâneos post-TTL disparavam N fetches pra connect.facebook.net (burst +
// rate limit risk). Agora: single flight via Promise in-flight — todos os callers
// aguardam o mesmo refresh.
let refreshPromise = null;
const CACHE_TTL = 3600000; // 1 hora

async function refreshCache(ua) {
  const resp = await fetch(PIXEL_JS_URL, {
    headers: { 'User-Agent': ua || 'Mozilla/5.0' },
  });
  if (!resp.ok) throw new Error(`fbevents.js fetch failed: status=${resp.status}`);
  const text = await resp.text();
  if (!text || text.length < 10000) throw new Error(`fbevents.js too small: bytes=${text.length}`);
  cachedScript = text;
  cacheTime = Date.now();
  return text;
}

export default async function handler(req, res) {
  // CORS — única fonte de origens permitidas em _lib/config.js
  const origin = req.headers['origin'] || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(200).end();
  }

  try {
    // Cache em memoria pra evitar buscar a cada request.
    // VALIDA resp.ok + tamanho mínimo pra não cachear resposta vazia/erro.
    if (!cachedScript || Date.now() - cacheTime > CACHE_TTL) {
      // Single-flight: se já há refresh em andamento, aguarda ele.
      if (!refreshPromise) {
        refreshPromise = refreshCache(req.headers['user-agent']);
      }
      try {
        await refreshPromise;
      } finally {
        // Always clear the single-flight promise; rejected promises would otherwise
        // be reused forever and force every request into the fallback redirect.
        refreshPromise = null;
      }
    }

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(cachedScript);
  } catch (err) {
    console.error(`[PIXEL PROXY] ${err.message} — fallback to direct Meta`);
    // Fallback: redireciona pro original (perde first-party cookies nessa request)
    return res.redirect(302, PIXEL_JS_URL);
  }
}
