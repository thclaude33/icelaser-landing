// api/_lib/clinic-routing.js
//
// FIX BUG 9 (Codex 17/05/2026): Lead Ads nativo estava routing Recife
// fixo em pontos críticos (whatsapp.js:1380, process-leadgen.js:241).
// Quando JP roda Lead Ad, user_data.city/state/page_id e Pixel ID
// iam pra Recife → contaminação cross-clinic.
//
// Helper centraliza decisão por page_id do payload leadgen.

import { PAGE_ID, PAGE_ID_JPA, PIXEL_ID, PIXEL_ID_JPA } from './config.js';

function recifeClinic() {
  return {
    clinic: 'recife',
    city: 'recife',
    state: 'pe',
    pageId: String(PAGE_ID),
    pixelId: String(PIXEL_ID),
    capiToken: process.env.CAPI_DATASET_TOKEN || process.env.META_ACCESS_TOKEN || '',
    isJp: false,
  };
}

function jpaClinic() {
  return {
    clinic: 'jpa',
    city: 'joao pessoa',
    state: 'pb',
    pageId: String(PAGE_ID_JPA),
    pixelId: String(PIXEL_ID_JPA),
    capiToken: process.env.CAPI_DATASET_TOKEN_JP || process.env.META_ACCESS_TOKEN || '',
    isJp: true,
  };
}

/**
 * Decide qual clínica processa o lead baseado no page_id do webhook leadgen.
 *
 * Meta envia `value.page_id` no payload de cada change. Esse é a fonte de
 * verdade (não o token ou env — esses são per-projeto).
 *
 * @param {string|number|null|undefined} pageId
 * @returns {{
 *   clinic: 'recife' | 'jpa',
 *   city: 'recife' | 'joao pessoa',
 *   state: 'pe' | 'pb',
 *   pageId: string,
 *   pixelId: string,
 *   capiToken: string,
 *   isJp: boolean,
 * }}
 */
export function resolveClinicFromPageId(pageId) {
  return resolveClinicFromPageIdStrict(pageId) || recifeClinic();
}

/**
 * Versão fail-closed para fluxos novos/risco cross-clinic.
 * Desconhecido não vira Recife por conveniência.
 *
 * @param {string|number|null|undefined} pageId
 * @returns {ReturnType<typeof recifeClinic>|ReturnType<typeof jpaClinic>|null}
 */
export function resolveClinicFromPageIdStrict(pageId) {
  const raw = String(pageId || '');
  if (raw && raw === String(PAGE_ID_JPA)) {
    return jpaClinic();
  }
  if (raw && raw === String(PAGE_ID)) {
    return recifeClinic();
  }
  return null;
}

/**
 * Decide qual clínica processa uma mensagem WhatsApp baseado no phone_number_id
 * do webhook Cloud API (`value.metadata.phone_number_id`).
 *
 * @param {string|number|null|undefined} phoneNumberId
 * @returns {{
 *   clinic: 'recife' | 'jpa',
 *   city: 'recife' | 'joao pessoa',
 *   state: 'pe' | 'pb',
 *   pageId: string,
 *   pixelId: string,
 *   capiToken: string,
 *   isJp: boolean,
 * }}
 */
export function resolveClinicFromPhoneNumberId(phoneNumberId) {
  return resolveClinicFromPhoneNumberIdStrict(phoneNumberId) || recifeClinic();
}

/**
 * Versão fail-closed para webhooks WhatsApp multi-clínica.
 * Desconhecido não pode cair no Chatwoot Recife.
 *
 * @param {string|number|null|undefined} phoneNumberId
 * @returns {ReturnType<typeof recifeClinic>|ReturnType<typeof jpaClinic>|null}
 */
export function resolveClinicFromPhoneNumberIdStrict(phoneNumberId) {
  const raw = String(phoneNumberId || '');
  const jpaPhoneId = String(process.env.WA_PHONE_NUMBER_ID_JPA || '');
  if (raw && jpaPhoneId && raw === jpaPhoneId) {
    return jpaClinic();
  }
  const recifePhoneId = String(process.env.WA_PHONE_NUMBER_ID || '');
  if (raw && recifePhoneId && raw === recifePhoneId) {
    return recifeClinic();
  }
  return null;
}
