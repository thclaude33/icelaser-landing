/**
 * Chatwoot label change detection helper.
 *
 * Extracted from crm-webhook.js pra testabilidade. Chatwoot v3/v4 envia
 * mudanças de label de 3 formas diferentes em changed_attributes:
 *   1. label_list: { previous_value: [...], current_value: [...] }      — array
 *   2. labels:     { previous_value: [...], current_value: [...] }      — array (legado)
 *   3. cached_label_list: { previous_value: "csv", current_value: "csv" } — string CSV
 *
 * Observado LIVE 23/04/2026 14:50 UTC: Chatwoot em produção envia apenas
 * `cached_label_list` (formato 3) quando atendente marca label. Sem suporte
 * a esse formato, código antigo retornava skipped no_label_change → CAPI
 * Lead/CR/Purchase não disparado → coverage wizard 0%.
 */

const LABEL_CHANGE_KEYS = ['label_list', 'labels', 'cached_label_list'];

/**
 * Parse valor de label_list em qualquer formato Chatwoot.
 * @param {any} v - array, string CSV, undefined
 * @returns {string[]}
 */
export function parseLabelValue(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

/**
 * Normaliza changed_attributes de Chatwoot pra array.
 * Chatwoot pode enviar como:
 *   - array: [{key1: val1}, {key2: val2}]
 *   - object: {key1: val1, key2: val2}
 *   - null/undefined: []
 */
export function normalizeChangedAttributes(rawChanged) {
  if (Array.isArray(rawChanged)) return rawChanged;
  if (rawChanged && typeof rawChanged === 'object') {
    return Object.entries(rawChanged).map(([k, v]) => ({ [k]: v }));
  }
  return [];
}

/**
 * Detecta se changed_attributes contém mudança de labels em qualquer formato.
 * @returns {boolean}
 */
export function hasLabelChange(changedAttributes) {
  const arr = normalizeChangedAttributes(changedAttributes);
  return arr.some(attr => LABEL_CHANGE_KEYS.some(k => attr?.[k] !== undefined));
}

/**
 * Extrai labels anteriores de qualquer formato Chatwoot.
 * @returns {string[]}
 */
export function extractPreviousLabels(changedAttributes) {
  const arr = normalizeChangedAttributes(changedAttributes);
  return arr
    .filter(attr => LABEL_CHANGE_KEYS.some(k => attr?.[k] !== undefined))
    .flatMap(attr => parseLabelValue(
      attr.label_list?.previous_value
      ?? attr.labels?.previous_value
      ?? attr.cached_label_list?.previous_value
    ));
}
