// api/_lib/clinic-routing.js
//
// FIX BUG 9 (Codex 17/05/2026): Lead Ads nativo estava routing Recife
// fixo em pontos críticos (whatsapp.js:1380, process-leadgen.js:241).
// Quando JP roda Lead Ad, user_data.city/state/page_id e Pixel ID
// iam pra Recife → contaminação cross-clinic.
//
// Helper centraliza decisão por page_id do payload leadgen.

import { PAGE_ID, PAGE_ID_JPA, PIXEL_ID, PIXEL_ID_JPA } from './config.js';

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
  const raw = String(pageId || '');
  if (raw && raw === String(PAGE_ID_JPA)) {
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
  // Default: Recife (legacy + match com PAGE_ID Recife)
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
