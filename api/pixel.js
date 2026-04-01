/**
 * /api/pixel — CNAME proxy para Meta Pixel JS
 * Carrega connect.facebook.net/en_US/fbevents.js do dominio icelasers.com.br
 * Resultado: cookies _fbp/_fbc sao first-party verdadeiros (mesmo dominio)
 * Safari ITP nao limita cookies first-party HTTP — persistem 180 dias
 */

const PIXEL_JS_URL = 'https://connect.facebook.net/en_US/fbevents.js';
let cachedScript = null;
let cacheTime = 0;
const CACHE_TTL = 3600000; // 1 hora

export default async function handler(req, res) {
  // CORS
  const origin = req.headers['origin'] || '';
  const allowed = [
    'https://icelaser-landing.vercel.app',
    'https://icelaser-landing-c9in.vercel.app',
    'https://landing-page-six-xi-77.vercel.app',
    'https://icelaser.com.br',
    'https://www.icelaser.com.br',
    'https://icelasers.com.br',
    'https://www.icelasers.com.br',
  ];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(200).end();
  }

  try {
    // Cache em memoria pra evitar buscar a cada request
    if (!cachedScript || Date.now() - cacheTime > CACHE_TTL) {
      const resp = await fetch(PIXEL_JS_URL, {
        headers: { 'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0' },
      });
      cachedScript = await resp.text();
      cacheTime = Date.now();
    }

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(cachedScript);
  } catch (err) {
    // Fallback: redireciona pro original
    return res.redirect(302, PIXEL_JS_URL);
  }
}
