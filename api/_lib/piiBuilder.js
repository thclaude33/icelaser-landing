/**
 * Meta capi-param-builder-nodejs SDK wrapper.
 *
 * Substitui nosso `sha256(normalizePhoneBR(x))` manual pelo algoritmo OFICIAL
 * da Meta — aplica:
 *   - email: lowercase + trim + validate RFC2822 + sha256
 *   - phone: remove non-digits + remove leading zeros + sha256
 *   - fn/ln/ct/st: lowercase + strip whitespace+punctuation + sha256
 *   - dob: YYYYMMDD (valida ano 1800+ e day 1-31) + sha256
 *   - country: 2-letter lowercase ou full name → normaliza
 *   - zip_code: lowercase + split('-')[0] + trim + sha256
 *   - gender: aceita man/male/boy/... → m ou woman/female/girl/... → f + sha256
 *   - external_id: trim + sha256 (preserva case se já vier hasheado)
 *
 * Meta SDK retorna formato `{hash}.{appendix}` se valor é novo normalizado,
 * ou só `{hash}` se input já era hasheado (evita double-hash).
 *
 * Fallback: se SDK não carregar (bundling edge runtime), usa sha256 manual.
 */

import crypto from 'crypto';
import { sha256 as manualSha256, normalizePhoneBR } from './security.js';

// Fix LOW AI deep v3 (piiBuilder.js:105): gender Sets em module scope.
// Antes: criados a cada call de manualFallback. Agora: uma alocação só por cold start.
const GENDER_MALE   = new Set(['m', 'male', 'man', 'boy', 'mr']);
const GENDER_FEMALE = new Set(['f', 'female', 'woman', 'girl', 'mrs', 'ms']);

// Fix LOW AI deep v3 (piiBuilder.js:81): regex mais estrito pra email.
// Anterior `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` aceita "a@b.c" e outros edge cases.
// Novo: exige local >= 1, domain com dot, TLD >= 2 chars, sem chars espúrios.
const EMAIL_STRICT = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

// Fix MEDIUM AI deep v3 (piiBuilder.js:93): mapeia nomes completos dos 27 estados
// BR pra abreviação oficial de 2 chars (Meta spec `st` recebe 2-char ISO/region
// code). Antes: `normalized.replace(/[^a-z]/g,'').slice(0,2)` pegava "saopaulo"
// → "so" em vez de "sp". Agora: nome completo → lookup → 2-char correto.
// Inputs já estão lowercase + strip non-alpha quando chegam aqui.
const STATE_FULLNAME_TO_ABBR = {
  acre: 'ac', alagoas: 'al', amapa: 'ap', amazonas: 'am',
  bahia: 'ba', ceara: 'ce', distritofederal: 'df',
  espiritosanto: 'es', goias: 'go', maranhao: 'ma',
  matogrosso: 'mt', matogrossodosul: 'ms', minasgerais: 'mg',
  para: 'pa', paraiba: 'pb', parana: 'pr', pernambuco: 'pe',
  piaui: 'pi', riodejaneiro: 'rj', riograndedonorte: 'rn',
  riograndedosul: 'rs', rondonia: 'ro', roraima: 'rr',
  santacatarina: 'sc', saopaulo: 'sp', sergipe: 'se',
  tocantins: 'to',
};

// Helper direto pra sha256 de valor já normalizado (evita SDK overhead e
// ambiguidade do path 'external_id' pros partial matching keys fi/f5first/f5last).
function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

let sdkParamBuilder = null;
let sdkLoadAttempted = false;

async function loadSdk() {
  if (sdkLoadAttempted) return sdkParamBuilder;
  sdkLoadAttempted = true;
  try {
    const mod = await import('capi-param-builder-nodejs');
    sdkParamBuilder = mod.ParamBuilder || mod.default?.ParamBuilder || null;
  } catch (e) {
    console.warn('[PII] SDK capi-param-builder-nodejs unavailable, using manual fallback:', e.message);
  }
  return sdkParamBuilder;
}

/**
 * Normaliza + hasha PII usando algoritmo oficial Meta.
 * @param {string} piiValue - valor plain ou já hasheado (detecta SHA-256 hex 64 chars)
 * @param {string} dataType - 'phone' | 'email' | 'first_name' | 'last_name' | 'date_of_birth' |
 *                            'gender' | 'city' | 'state' | 'zip_code' | 'country' | 'external_id'
 * @returns {Promise<string>} hash + appendix opcional
 */
export async function hashPII(piiValue, dataType) {
  if (!piiValue) return null;
  const input = String(piiValue);
  // Fast path: se já é SHA-256 (64 hex chars), retorna como está (evita double-hash)
  if (/^[A-Fa-f0-9]{64}$/.test(input.trim())) {
    return input.trim().toLowerCase();
  }
  const Sdk = await loadSdk();
  if (Sdk) {
    try {
      const builder = new Sdk();
      const out = builder.getNormalizedAndHashedPII(input, dataType);
      // SDK retorna `{hash}.{appendix}` — strip appendix pra compat com CAPI
      // (CAPI espera só hex SHA-256 no user_data, sem .appendix).
      // Meta docs confirmam: appendix só no cookie fbc/fbp, NÃO em em/ph/fn/etc.
      if (out && typeof out === 'string') {
        const hashOnly = out.split('.')[0];
        if (/^[a-f0-9]{64}$/.test(hashOnly)) return hashOnly;
      }
    } catch (e) {
      console.warn(`[PII] SDK call failed for ${dataType}: ${e.message}`);
    }
  }
  // Fallback manual: matches nosso comportamento anterior pra não regredir
  return manualFallback(input, dataType);
}

function manualFallback(value, dataType) {
  let normalized = String(value).trim().toLowerCase();
  switch (dataType) {
    case 'phone':
      // Fix HIGH AI deep review v2 B2 (piiBuilder.js:77): `.replace(/^0+/, '')`
      // apagava prefixo 0 mas alguns DDDs ou country codes têm 0 (ex: "5508199..."
      // hipotético). E.164 correto: manter só dígitos, não remover zeros líderes
      // arbitrariamente. normalizePhoneBR em security.js já lida com 55+DDD.
      normalized = normalized.replace(/[^0-9]/g, '');
      if (!normalized) return null;
      break;
    case 'email':
      // Fix LOW AI deep v3 (piiBuilder.js:81): regex estrito que pega a maioria
      // dos edge cases inválidos que o regex permissivo antigo aceitava.
      if (!EMAIL_STRICT.test(normalized)) return null;
      break;
    case 'first_name':
    case 'last_name':
    case 'city':
      // remove acentos + whitespace + pontuação
      normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[!"#$%&'()*+,\-./:;<=>?@ \[\]^_`{|}~\s]+/g, '');
      if (!normalized) return null;
      break;
    case 'state': {
      // Fix MEDIUM AI deep v3 (piiBuilder.js:93): accept state como nome completo
      // OU abreviação 2-char. Antes: slice(0,2) pegava "so" de "saopaulo" em
      // vez de "sp". Agora: strip accents+non-alpha → lookup fullname → se achou,
      // usa abreviação; senão assume que input já era 2-char abbr.
      const cleaned = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z]/g, '');
      if (!cleaned) return null;
      normalized = STATE_FULLNAME_TO_ABBR[cleaned] || cleaned.slice(0, 2);
      break;
    }
    case 'country':
      normalized = normalized.replace(/[^a-z]/g, '').slice(0, 2);
      break;
    case 'zip_code':
      // lowercase + split('-')[0] + trim
      normalized = normalized.split('-')[0].trim();
      if (normalized.length < 2) return null;
      break;
    case 'gender':
      // m/f only — usa Sets em module scope (evita alocar por call).
      if (GENDER_MALE.has(normalized)) normalized = 'm';
      else if (GENDER_FEMALE.has(normalized)) normalized = 'f';
      else return null;
      break;
    case 'date_of_birth':
      // YYYYMMDD expected; validate
      normalized = normalized.replace(/\D/g, '');
      if (normalized.length !== 8) return null;
      const yr = parseInt(normalized.slice(0, 4), 10);
      const mo = parseInt(normalized.slice(4, 6), 10);
      const dy = parseInt(normalized.slice(6, 8), 10);
      const curYr = new Date().getFullYear();
      if (yr < 1800 || yr > curYr + 1 || mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
      break;
    case 'external_id':
      // trim só, preserva case (idempotente ao re-hash)
      normalized = String(value).trim();
      if (!normalized) return null;
      return crypto.createHash('sha256').update(normalized).digest('hex');
    default:
      break;
  }
  return normalized ? crypto.createHash('sha256').update(normalized).digest('hex') : null;
}

/**
 * Batch helper: recebe user_data plain-text e retorna hashed conforme Meta SDK.
 * Campos não-PII (fbp, fbc, client_ip_address, client_user_agent, ctwa_clid,
 * whatsapp_business_account_id, page_id, page_scoped_user_id, ig_sid, lead_id) NÃO são hasheados.
 *
 * Advanced matching partial keys (Meta Java SDK oficial 2026):
 *  - f5first: primeiros 5 chars do first_name, normalizados e hasheados
 *  - f5last: primeiros 5 chars do last_name, normalizados e hasheados
 *  - fi: inicial do first_name, normalizada e hasheada
 *  - dobd/dobm/doby: dia/mês/ano de nascimento individual, cada um hasheado
 * Quando fn/ln chegam completos, enviamos os partial keys TAMBÉM pra aumentar
 * matching surface (Meta compara múltiplas keys em paralelo → mais chance de match).
 */
export async function buildUserData(plain) {
  const ud = {};
  // Fix MEDIUM AI deep v3 (piiBuilder.js:93): pré-mapear state full-name BR → 2-char
  // abbr ANTES do SDK Meta. SDK faz slice(0,2) que quebra "saopaulo" → "sa" (esperado "sp").
  // Aplicamos mapeamento aqui, depois SDK apenas hashea o 2-char correto.
  let normalizedState = plain.state;
  if (typeof plain.state === 'string' && plain.state.length > 2) {
    const cleaned = plain.state.toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
    if (STATE_FULLNAME_TO_ABBR[cleaned]) {
      normalizedState = STATE_FULLNAME_TO_ABBR[cleaned];
    }
  }
  const pii = [
    ['em', plain.email, 'email'],
    ['ph', plain.phone, 'phone'],
    ['fn', plain.first_name, 'first_name'],
    ['ln', plain.last_name, 'last_name'],
    ['db', plain.date_of_birth, 'date_of_birth'],
    ['ge', plain.gender, 'gender'],
    ['ct', plain.city, 'city'],
    ['st', normalizedState, 'state'],
    ['zp', plain.zip_code, 'zip_code'],
    ['country', plain.country, 'country'],
    ['external_id', plain.external_id, 'external_id'],
  ];
  for (const [key, val, type] of pii) {
    if (val) {
      const h = await hashPII(val, type);
      if (h) ud[key] = [h];
    }
  }

  // Advanced matching partial keys (Meta Java SDK oficial 2026 spec):
  //   - fi: lowercase + strip ws+punct → primeiro char → sha256
  //   - f5first: lowercase + strip ws+punct → primeiros 5 chars → sha256
  //   - f5last:  lowercase + strip ws+punct → primeiros 5 chars → sha256
  //   - dobd/dobm/doby: 2/2/4 dígitos do DOB, individualmente → sha256
  //
  // AI sanity deep v3 REVERT: manter path hashPII('external_id') em vez de
  // sha256Hex direto. SDK path garante consistência com Pixel browser quando
  // SDK aplica normalização interna (trim + sha256). sha256Hex puro pode diverger
  // se SDK futuro mudar. hashPII fallback manual já é trim+sha256 (mesmo output).
  // Fix LOW AI deep v3 (piiBuilder.js:171): remover await fnNormHash unused (mantido).
  const PUNCT_WS = /[!"#$%&'()*+,\-./:;<=>?@ \[\]^_`{|}~\s]+/g;
  if (plain.first_name) {
    const normFirst = String(plain.first_name).toLowerCase().replace(PUNCT_WS, '');
    if (normFirst.length > 0) {
      const fiHash = await hashPII(normFirst.charAt(0), 'external_id');
      const f5Hash = await hashPII(normFirst.slice(0, 5), 'external_id');
      if (fiHash) ud.fi = [fiHash];
      if (f5Hash) ud.f5first = [f5Hash];
    }
  }
  if (plain.last_name) {
    const normLast = String(plain.last_name).toLowerCase().replace(PUNCT_WS, '');
    if (normLast.length > 0) {
      const f5lHash = await hashPII(normLast.slice(0, 5), 'external_id');
      if (f5lHash) ud.f5last = [f5lHash];
    }
  }
  // DOB partials: se date_of_birth (YYYYMMDD) chegou, derivar dobd/dobm/doby.
  if (plain.date_of_birth) {
    const dobDigits = String(plain.date_of_birth).replace(/\D/g, '');
    if (dobDigits.length === 8) {
      const [doyH, domH, dodH] = await Promise.all([
        hashPII(dobDigits.slice(0, 4), 'external_id'),
        hashPII(dobDigits.slice(4, 6), 'external_id'),
        hashPII(dobDigits.slice(6, 8), 'external_id'),
      ]);
      if (doyH) ud.doby = [doyH];
      if (domH) ud.dobm = [domH];
      if (dodH) ud.dobd = [dodH];
    }
  }
  // Non-hashed keys pass-through (Meta requer plain)
  if (plain.fbp) ud.fbp = plain.fbp;
  if (plain.fbc) ud.fbc = plain.fbc;
  if (plain.client_ip_address) ud.client_ip_address = plain.client_ip_address;
  if (plain.client_user_agent) ud.client_user_agent = plain.client_user_agent;
  if (plain.ctwa_clid) ud.ctwa_clid = plain.ctwa_clid;
  if (plain.whatsapp_business_account_id) ud.whatsapp_business_account_id = plain.whatsapp_business_account_id;
  if (plain.page_id) ud.page_id = plain.page_id;
  if (plain.page_scoped_user_id) ud.page_scoped_user_id = plain.page_scoped_user_id;
  if (plain.subscription_id) ud.subscription_id = plain.subscription_id;
  if (plain.fb_login_id) ud.fb_login_id = plain.fb_login_id;
  if (plain.ig_account_id) ud.ig_account_id = plain.ig_account_id;
  if (plain.ig_sid) ud.ig_sid = plain.ig_sid;
  if (plain.lead_id) ud.lead_id = plain.lead_id;
  return ud;
}
