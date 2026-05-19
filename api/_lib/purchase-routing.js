/**
 * Purchase/Events CRM routing — Pixel-only decision.
 *
 * PROBLEMA (descoberto empíricamente 23/04/2026):
 *   Meta NÃO faz dedup cross-dataset mesmo com mesmo event_id.
 *   Creative Testing contou 2× Purchase da Bruna (R$ 2.037,60 = R$ 1.018,80 × 2
 *   datasets) porque fan-out CRM enviava pro Pixel LP + WAM simultaneamente.
 *
 * PESQUISA EXAUSTIVA CONCLUSÃO:
 *   - Não existe feature oficial Meta pra cross-dataset dedup
 *   - original_event_data (Meta SDK) é pra "attribution passback / GVO",
 *     não cross-dataset dedup
 *   - Meta Conversions API Gateway resolve multi-domain MESMO pixel,
 *     não 2 pixels recebendo mesmo evento
 *
 * SOLUÇÃO V5:
 *   WAM fica em quarentena total. Cada evento CRM vai para o Pixel LP correto;
 *   payment_method fica apenas como contexto/auditoria.
 *
 * SAFETY:
 *   - Feature flag: PURCHASE_ROUTING_ENABLED=1 (default) habilita
 *   - Qualquer erro no routing: callers caem no Pixel LP
 *   - Fail-safe: sem payment_method → Pixel LP
 *
 * Docs oficiais Meta:
 *   - business_messaging: https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging/
 *   - CRM integration:    https://developers.facebook.com/docs/marketing-api/conversions-api/conversion-leads-integration/
 */

export const DATASET_PIXEL_LP = 'pixel_lp';

export const VALID_PAYMENT_METHODS = ['presencial', 'wa_link', 'outros'];

const PRESENCIAL_KEYWORDS = ['presencial', 'maquininha', 'clinica', 'fisica', 'pessoalmente'];
const WA_LINK_KEYWORDS   = ['wa_link', 'whatsapp', 'link', 'online', 'digital', 'pagamento_link'];

/**
 * Normaliza string ao minúsculo + remove emoji/espaços extras pra comparação.
 * Ex: "💰 WA Link" → "wa link"
 */
function normalize(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/gu, '')  // remove emojis
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decide destino do event CRM baseado em múltiplos sinais.
 *
 * Ordem de prioridade:
 *   1. payment_method explícito (atendente marcou) — precisão 100%
 *   2. ctwa_clid presente (conversa veio de ad CTWA) — contexto/auditoria
 *   3. leadgen_id presente (Meta Lead Ad Instant Form) — contexto/auditoria
 *   4. Fallback → Pixel LP
 *
 * @param {object} opts
 * @param {object} opts.customAttrs - custom_attributes mesclados (contact + conversation)
 * @param {string} [opts.ctwa_clid] - Click-to-WhatsApp ID se disponível
 * @returns {{ target: string, action_source: string, reason: string }}
 */
export function decideTargetDataset({ customAttrs, ctwa_clid } = {}) {
  const attrs = customAttrs || {};
  const pmNorm = normalize(attrs.payment_method);

  const hasValidCtwa = ctwa_clid && typeof ctwa_clid === 'string' && ctwa_clid.length >= 32;

  // 1. payment_method explícito (atendente marcou)
  if (pmNorm) {
    const isPresencial = PRESENCIAL_KEYWORDS.some(kw => pmNorm.includes(kw));
    const isWaLink = WA_LINK_KEYWORDS.some(kw => pmNorm.includes(kw));

    if (isPresencial) {
      return {
        target: DATASET_PIXEL_LP,
        action_source: 'system_generated',
        reason: 'payment_method_presencial',
      };
    }
    if (isWaLink) {
      return {
        target: DATASET_PIXEL_LP,
        action_source: 'system_generated',
        reason: hasValidCtwa ? 'payment_method_wa_link_ctwa_pixel' : 'payment_method_wa_link_pixel',
      };
    }
    if (pmNorm.includes('outros') || pmNorm.includes('other')) {
      // "outros" vai pro Pixel LP por ser categoria não-WA — conservador
      return {
        target: DATASET_PIXEL_LP,
        action_source: 'system_generated',
        reason: 'payment_method_outros',
      };
    }
    // payment_method inválido (ex: "asdf") → ignora e cai em fallback
  }

  // 2. Inferência por ctwa_clid (CTWA click — user veio de ad)
  if (hasValidCtwa) {
    return {
      target: DATASET_PIXEL_LP,
      action_source: 'system_generated',
      reason: 'ctwa_clid_pixel_only',
    };
  }

  // 3. Inferência por leadgen_id (Meta Lead Ad Instant Form)
  if (attrs.leadgen_id && /^\d{15,17}$/.test(String(attrs.leadgen_id))) {
    return {
      target: DATASET_PIXEL_LP,
      action_source: 'system_generated',
      reason: 'leadgen_id_pixel_only',
    };
  }

  // 4. Fallback — Pixel LP. WAM está em quarentena total no V5.
  return {
    target: DATASET_PIXEL_LP,
    action_source: 'system_generated',
    reason: 'fallback_default_pixel',
  };
}

/**
 * Parse purchase_value em formato variado (BR, US, número).
 * @param {number|string} v
 * @returns {number|null} — null se inválido (caller decide default)
 */
export function parsePurchaseValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (isNaN(v) || v < 0) return null;
    return v;
  }
  if (typeof v !== 'string') return null;
  const cleaned = v
    .replace(/R\$\s*/gi, '')
    .replace(/\s+/g, '')
    .trim();
  if (!cleaned) return null;
  let num;
  // Se tem vírgula e ponto: ponto é milhar, vírgula é decimal (padrão BR: 1.018,80)
  if (cleaned.includes(',') && cleaned.includes('.')) {
    num = parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  } else if (cleaned.includes(',')) {
    // Só vírgula: decimal BR (599,40)
    num = parseFloat(cleaned.replace(',', '.'));
  } else {
    // Padrão US ou inteiro
    num = parseFloat(cleaned);
  }
  if (isNaN(num) || num < 0) return null;
  return num;
}

/**
 * Check if routing is enabled via env var (feature flag pra rollback rápido).
 * Default: true (habilitado).
 */
export function isRoutingEnabled() {
  return process.env.PURCHASE_ROUTING_ENABLED !== '0';
}
