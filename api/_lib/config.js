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
export const AD_ACCOUNT_ID = envOr('META_AD_ACCOUNT_ID', 'act_790663154114264');
export const APP_ID = envOr('META_APP_ID', '940244045396548');

export const GRAPH_VERSION = 'v25.0';
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Default purchase value (pode ser sobrescrito por customAttrs.purchase_value)
export const DEFAULT_PURCHASE_VALUE = parseFloat(process.env.DEFAULT_PURCHASE_VALUE || '497');
export const DEFAULT_PREDICTED_LTV = parseFloat(process.env.DEFAULT_PREDICTED_LTV || '980');

export const ALLOWED_ORIGINS = [
  'https://icelaser-landing.vercel.app',
  'https://icelaser-landing-c9in.vercel.app',
  'https://landing-page-six-xi-77.vercel.app',
  'https://icelaser.com.br',
  'https://www.icelaser.com.br',
  'https://icelasers.com.br',
  'https://www.icelasers.com.br',
];

export function canonicalOrigin(origin) {
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}
