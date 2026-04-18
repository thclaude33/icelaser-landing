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
      normalized = normalized.replace(/[^0-9]/g, '').replace(/^0+/, '');
      if (!normalized) return null;
      break;
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
      break;
    case 'first_name':
    case 'last_name':
    case 'city':
      // remove acentos + whitespace + pontuação
      normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[!"#$%&'()*+,\-./:;<=>?@ \[\]^_`{|}~\s]+/g, '');
      if (!normalized) return null;
      break;
    case 'state':
      // 2-letter lowercase
      normalized = normalized.replace(/[^a-z]/g, '').slice(0, 2);
      break;
    case 'country':
      normalized = normalized.replace(/[^a-z]/g, '').slice(0, 2);
      break;
    case 'zip_code':
      // lowercase + split('-')[0] + trim
      normalized = normalized.split('-')[0].trim();
      if (normalized.length < 2) return null;
      break;
    case 'gender':
      // m/f only
      const m = new Set(['m', 'male', 'man', 'boy', 'mr']);
      const f = new Set(['f', 'female', 'woman', 'girl', 'mrs', 'ms']);
      if (m.has(normalized)) normalized = 'm';
      else if (f.has(normalized)) normalized = 'f';
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
 * whatsapp_business_account_id, page_id, page_scoped_user_id, ig_sid) NÃO são hasheados.
 */
export async function buildUserData(plain) {
  const ud = {};
  const pii = [
    ['em', plain.email, 'email'],
    ['ph', plain.phone, 'phone'],
    ['fn', plain.first_name, 'first_name'],
    ['ln', plain.last_name, 'last_name'],
    ['db', plain.date_of_birth, 'date_of_birth'],
    ['ge', plain.gender, 'gender'],
    ['ct', plain.city, 'city'],
    ['st', plain.state, 'state'],
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
  return ud;
}
