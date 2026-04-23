/**
 * Funnel guards — função pura pra decidir quando disparar Lead + CR
 * no bloco `compra_realizada` do crm-webhook.js.
 *
 * Extraída em 23/04/2026 (AI review Opus 4.6 — VA-4 testability) pra:
 *   1. Testável em isolamento (cenários tabela abaixo)
 *   2. Prevenir regressão Q2 (compra_realizada + lead_frio simultâneos = 2 Leads)
 *   3. Docs explícitas da lógica em 1 lugar
 *
 * TABELA DE CENÁRIOS (verdade esperada):
 *
 * | # | currentLabels            | previousLabels            | needLead | needCR | Comentário |
 * |---|--------------------------|---------------------------|----------|--------|-----------|
 * | 1 | [compra]                 | []                        | TRUE     | TRUE   | direto → compra (funil completo inferido) |
 * | 2 | [lead_frio, compra]      | []                        | FALSE    | TRUE   | cold_lead block dispara Lead; CR falta |
 * | 3 | [lead_quente, compra]    | []                        | FALSE    | FALSE  | hot_lead block dispara Lead+CR |
 * | 4 | [compra]                 | [lead_frio]               | FALSE    | TRUE   | frio antes enviou Lead; CR falta agora |
 * | 5 | [compra]                 | [lead_quente]             | FALSE    | FALSE  | quente antes enviou Lead+CR |
 * | 6 | [compra]                 | [lead_frio, lead_quente]  | FALSE    | FALSE  | ambos antes cobriram Lead+CR |
 * | 7 | [lead_frio, compra]      | [lead_quente]             | FALSE    | FALSE  | quente antes (Lead+CR) + frio atual (Lead dup protegido por hasColdNow) |
 * | 8 | [compra_realizada,sold]  | []                        | TRUE     | TRUE   | sinônimo de compra (sold), mesmo que #1 |
 *
 * O guard Q2 (adicionado 23/04) evita regressão:
 *   currentLabels=[lead_frio,compra] → cold_lead block fires Lead (_cold_lead)
 *   ANTES do fix: needLead=true (pois !hadColdBefore, !hadHotBefore, !hasHotNow)
 *   → dispara 2º Lead com event_id _compra_lead → Meta NÃO dedupa → CPL inflado
 *   APÓS fix: hasColdNow=true → needLead=false ✅
 */

// Fix Vercel Agent review (23/04/2026): 2 fixes ao regex original:
//   1. Escape dot: `lead.quente` (dot=any char) → `lead[\s_]quente` (só space/underscore)
//   2. Word boundary: `|quente` (substring match) → `\b(?:...)\b` (só palavra completa)
// Efeito combinado: zero false positives tipo "leadaquente" ou "muitoquente"
// (variantes legítimas como "lead_quente", "lead quente", "quente" sozinho seguem matching).
const HOT_PATTERNS = /\b(?:hot_lead|lead[\s_]quente|quente)\b/i;
const COLD_PATTERNS = /\b(?:cold_lead|lead[\s_]frio|lead_frio|frio)\b/i;

// Variantes aceitas pra hot/cold labels (usado por hasLabel no crm-webhook).
// Mantemos em sync com a lista hasLabel() do crm-webhook.js.
const HOT_LABEL_VARIANTS = [
  'lead_quente',
  '🔥 Lead Quente',
  '🔥_lead_quente',
  'hot_lead',
  'lead quente',
  'quente',
];

const COLD_LABEL_VARIANTS = [
  'lead_frio',
  '🧊 Lead Frio',
  '🧊_lead_frio',
  'cold_lead',
  'lead frio',
  'frio',
];

/**
 * @param {Array<string>} currentLabels - labels ATUAIS do contact/conversation no webhook
 * @param {Array<string>} previousLabels - labels que estavam antes desta mudança
 * @returns {{ hasHotNow, hasColdNow, hadHotBefore, hadColdBefore, needLead, needCR }}
 */
export function computeCompraRealizadaGuards(currentLabels, previousLabels) {
  const cur = Array.isArray(currentLabels) ? currentLabels : [];
  const prev = Array.isArray(previousLabels) ? previousLabels : [];

  const hasLabelIn = (variants, list) => {
    const lowerVariants = variants.map((v) => String(v).toLowerCase());
    return list.some((l) => lowerVariants.includes(String(l).toLowerCase()));
  };

  const hasHotNow = hasLabelIn(HOT_LABEL_VARIANTS, cur);
  const hasColdNow = hasLabelIn(COLD_LABEL_VARIANTS, cur);
  const hadHotBefore = prev.some((l) => HOT_PATTERNS.test(String(l)));
  const hadColdBefore = prev.some((l) => COLD_PATTERNS.test(String(l)));

  // needLead: disparar Lead no block compra_realizada APENAS se nenhum outro
  // block (hot/cold, atual ou anterior) já enviou Lead.
  const needLead = !hasHotNow && !hasColdNow && !hadHotBefore && !hadColdBefore;

  // needCR: disparar CompleteRegistration APENAS se hot_lead não rodou (cold
  // não dispara CR — só Lead). Se lead_frio atual ou anterior: ainda precisa CR.
  const needCR = !hasHotNow && !hadHotBefore;

  return { hasHotNow, hasColdNow, hadHotBefore, hadColdBefore, needLead, needCR };
}

export const FUNNEL_GUARD_TEST_CASES = [
  { name: 'direto → compra',                    cur: ['compra_realizada'],                  prev: [],                               needLead: true,  needCR: true },
  { name: 'frio + compra simultâneos',          cur: ['lead_frio', 'compra_realizada'],     prev: [],                               needLead: false, needCR: true },
  { name: 'quente + compra simultâneos',        cur: ['lead_quente', 'compra_realizada'],   prev: [],                               needLead: false, needCR: false },
  { name: 'compra após lead_frio anterior',     cur: ['compra_realizada'],                  prev: ['lead_frio'],                    needLead: false, needCR: true },
  { name: 'compra após lead_quente anterior',   cur: ['compra_realizada'],                  prev: ['lead_quente'],                  needLead: false, needCR: false },
  { name: 'compra após frio+quente anteriores', cur: ['compra_realizada'],                  prev: ['lead_frio', 'lead_quente'],     needLead: false, needCR: false },
  { name: 'frio atual + quente anterior + compra', cur: ['lead_frio', 'compra_realizada'],  prev: ['lead_quente'],                  needLead: false, needCR: false },
  { name: 'sinônimo sold',                      cur: ['compra_realizada'],                  prev: [],                               needLead: true,  needCR: true },
  { name: 'emoji labels',                       cur: ['🔥 Lead Quente', 'compra_realizada'], prev: [],                              needLead: false, needCR: false },
  { name: 'case insensitive quente',            cur: ['LEAD QUENTE', 'compra_realizada'],   prev: [],                               needLead: false, needCR: false },
];
