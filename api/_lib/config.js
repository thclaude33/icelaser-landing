/**
 * Configuração compartilhada — todos os valores hardcoded movidos pra env.
 * Fallback defaults mantêm o sistema funcionando se a env var não existir,
 * mas o log avisa quando cai no fallback.
 */

function envOr(key, fallback) {
  const v = process.env[key];
  if (!v) {
    console.warn(`[CONFIG] ⚠️  ${key} não configurado, usando fallback`);
    return fallback;
  }
  return v;
}

export const PIXEL_ID = envOr('META_PIXEL_ID', '2774496306216737');
export const WABA_ID = envOr('META_WABA_ID', '920807647253970');
export const PAGE_ID = envOr('META_PAGE_ID', '111790301665816');
// Multi-tenant Page routing — IceLaser Bancários (JP).
// Adicionado 26/04/2026 pra fix cross-clinic data leak em crm-webhook.
export const PAGE_ID_JPA = envOr('META_PAGE_ID_JPA', '1077786125420191');
export const AD_ACCOUNT_ID = envOr('META_AD_ACCOUNT_ID', 'act_790663154114264');
export const APP_ID = envOr('META_APP_ID', '940244045396548');

// Multi-tenant Pixel routing — IceLaser Recife (Pixel default acima) +
// IceLaser João Pessoa (Bancários + Bessa). Cada cidade tem Pixel próprio
// pra audiences/LAL isoladas (LGPD + reports limpos).
export const PIXEL_ID_JPA = envOr('META_PIXEL_ID_JPA', '1386967056530127');

// Dataset dedicado pro Kommo CAPI server-side (criado 01/05/2026 pela equipe
// externa, semanticamente JPA). Separado de PIXEL_ID_JPA pra isolar:
//   - PIXEL_ID_JPA   = LP browser tracking + Chatwoot routing (1386967056530127)
//   - KOMMO_CAPI_DATASET = Kommo CRM stage transitions only (1694874711857319)
// Isso evita cross-mixing entre paths de tracking distintos.
export const KOMMO_CAPI_DATASET = envOr('KOMMO_CAPI_DATASET_ID', '1694874711857319');

/**
 * Resolve qual Pixel usar baseado no host HTTP (Origin header ou hostname).
 * Cobre prod (jpa.icelasers.com.br) e preview Vercel (slug com 'jpa'/'bancarios').
 * Default Recife pra qualquer outro host (icelasers.com.br, www.*, etc).
 *
 * @param {string|null|undefined} host
 * @returns {string} Pixel ID correto pra esse host
 */
export function getPixelByHost(host) {
  if (typeof host !== 'string' || !host) return PIXEL_ID;
  // jpa.icelasers.com.br (prod) ou preview Vercel com "jpa"/"bancarios" no slug
  if (host === 'jpa.icelasers.com.br') return PIXEL_ID_JPA;
  if (host.includes('.vercel.app') && /jpa|jp-routing|bancarios/i.test(host)) return PIXEL_ID_JPA;
  return PIXEL_ID;
}

// GRAPH_VERSION via env var — Meta lança versão nova a cada trimestre.
// v25.0 é ativa em abr/2026. Atualizar via env var evita redeploy manual.
export const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Default values com validação Number.isFinite — parseFloat('abc') = NaN,
// que corrompe Purchase events silenciosamente se env var malformada.
function parseFloatSafe(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
export const DEFAULT_PURCHASE_VALUE = parseFloatSafe(process.env.DEFAULT_PURCHASE_VALUE, 497);
export const DEFAULT_PREDICTED_LTV = parseFloatSafe(process.env.DEFAULT_PREDICTED_LTV, 980);

export const ALLOWED_ORIGINS = [
  'https://icelaser-landing.vercel.app',
  'https://icelaser-landing-c9in.vercel.app',
  'https://landing-page-six-xi-77.vercel.app',
  'https://icelaser.com.br',
  'https://www.icelaser.com.br',
  'https://icelasers.com.br',
  'https://www.icelasers.com.br',
  // IceLaser João Pessoa (Bancários + Bessa)
  'https://jpa.icelasers.com.br',
];

/**
 * Verifica se uma origin é permitida pra CORS (whitelist + Vercel preview JP).
 * - Lista estática ALLOWED_ORIGINS (cobre prod Recife + JP + 3 deploys Vercel)
 * - Dinamicamente: Vercel preview URLs com slug 'jpa'/'jp-routing'/'bancarios'
 *   (mesmo critério usado em middleware.js + getPixelByHost)
 *
 * Sem essa função: CORS bloqueia /api/track em previews JP → tracking quebra durante teste.
 *
 * @param {string|null|undefined} origin - Origin header completo (ex: "https://host.tld")
 * @returns {boolean}
 */
export function isOriginAllowed(origin) {
  if (!origin || typeof origin !== 'string') return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Vercel preview URL JP — mesmo regex que middleware.js usa pra isJpPreview
  try {
    const hostname = new URL(origin).hostname;
    if (hostname && hostname.includes('.vercel.app') && /jpa|jp-routing|bancarios/i.test(hostname)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
