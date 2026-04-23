/**
 * Test suite: funnel-guards.js
 * Runtime: Node built-in test (node 18+)
 * Run: npm test OR node --test tests/
 *
 * Validates compra_realizada guards para prevenir regressão Q2
 * (compra + lead_frio simultâneos = 2 Leads duplicados ao Meta).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCompraRealizadaGuards,
  FUNNEL_GUARD_TEST_CASES,
} from '../api/_lib/funnel-guards.js';

describe('computeCompraRealizadaGuards — tabela de cenários', () => {
  for (const tc of FUNNEL_GUARD_TEST_CASES) {
    test(tc.name, () => {
      const result = computeCompraRealizadaGuards(tc.cur, tc.prev);
      assert.equal(
        result.needLead,
        tc.needLead,
        `needLead esperado=${tc.needLead} mas veio=${result.needLead} | cur=${JSON.stringify(tc.cur)} prev=${JSON.stringify(tc.prev)}`
      );
      assert.equal(
        result.needCR,
        tc.needCR,
        `needCR esperado=${tc.needCR} mas veio=${result.needCR} | cur=${JSON.stringify(tc.cur)} prev=${JSON.stringify(tc.prev)}`
      );
    });
  }
});

describe('computeCompraRealizadaGuards — regressão Q2 (bug fix 23/04)', () => {
  test('Q2 core: operador adiciona lead_frio + compra simultâneos. needLead DEVE SER false (bloco cold_lead já dispara Lead)', () => {
    const { needLead, needCR, hasColdNow } = computeCompraRealizadaGuards(
      ['lead_frio', 'compra_realizada'],
      []
    );
    assert.equal(hasColdNow, true, 'hasColdNow detecta lead_frio atual');
    assert.equal(needLead, false, 'needLead FALSE pra evitar Lead duplicado com _cold_lead');
    assert.equal(needCR, true, 'needCR TRUE (cold_lead não dispara CR, precisa inferir)');
  });

  test('Q2 emoji: 🧊 Lead Frio + compra_realizada simultâneos', () => {
    const { needLead, hasColdNow } = computeCompraRealizadaGuards(
      ['🧊 Lead Frio', 'compra_realizada'],
      []
    );
    assert.equal(hasColdNow, true, 'hasColdNow detecta emoji label');
    assert.equal(needLead, false, 'needLead false mesmo com emoji');
  });

  test('Q2 underscore: 🧊_lead_frio + compra_realizada simultâneos', () => {
    const { needLead, hasColdNow } = computeCompraRealizadaGuards(
      ['🧊_lead_frio', 'compra_realizada'],
      []
    );
    assert.equal(hasColdNow, true);
    assert.equal(needLead, false);
  });

  test('Q2 case-insensitive: LEAD_FRIO upper + compra', () => {
    const { needLead, hasColdNow } = computeCompraRealizadaGuards(
      ['LEAD_FRIO', 'COMPRA_REALIZADA'],
      []
    );
    assert.equal(hasColdNow, true);
    assert.equal(needLead, false);
  });
});

describe('computeCompraRealizadaGuards — edge cases', () => {
  test('input null/undefined → arrays vazios safe', () => {
    const r1 = computeCompraRealizadaGuards(null, null);
    assert.equal(r1.needLead, true, 'sem labels = precisa inferir Lead');
    assert.equal(r1.needCR, true);
    const r2 = computeCompraRealizadaGuards(undefined, undefined);
    assert.equal(r2.needLead, true);
    assert.equal(r2.needCR, true);
  });

  test('previousLabels com labels "frio" sem lead_frio explicito', () => {
    const { hadColdBefore } = computeCompraRealizadaGuards(
      ['compra_realizada'],
      ['frio']  // alguem pôs só "frio"
    );
    assert.equal(hadColdBefore, true, 'regex cold pattern pega "frio" solto em previousLabels');
  });

  test('hot_lead em previousLabels sem emoji', () => {
    const { hadHotBefore, needCR } = computeCompraRealizadaGuards(
      ['compra_realizada'],
      ['hot_lead']
    );
    assert.equal(hadHotBefore, true);
    assert.equal(needCR, false, 'hot_lead já enviou Lead+CR');
  });

  test('currentLabels com typo tipo "leadfrio" (sem separador)', () => {
    const { hasColdNow } = computeCompraRealizadaGuards(
      ['leadfrio', 'compra_realizada'],
      []
    );
    // "leadfrio" não bate com nenhuma variante explícita (hasLabel usa lista),
    // então hasColdNow=false. Seguro: melhor falso-negativo (disparo duplicado 1x)
    // do que falso-positivo (não dispara quando deveria).
    assert.equal(hasColdNow, false, 'variante nao listada = nao detectada (safe)');
  });

  test('Vercel Agent finding: regex NÃO deve match "leadaquente" (dot não escapado bug)', () => {
    // Antes do fix: /hot_lead|lead.quente/i matchava "leadaquente" (dot = any char).
    // Depois do fix: /hot_lead|lead[\s_]quente/i só aceita space ou underscore.
    // Validar via previousLabels (onde regex HOT_PATTERNS é usado).
    const { hadHotBefore: bug1 } = computeCompraRealizadaGuards(
      ['compra_realizada'],
      ['leadaquente']  // typo/garbage que ANTES disparava false positive
    );
    assert.equal(bug1, false, 'leadaquente NÃO deve ser detectado como hot_lead');

    const { hadHotBefore: bug2 } = computeCompraRealizadaGuards(
      ['compra_realizada'],
      ['lead1quente', 'leadXquente', 'leadSquente']
    );
    assert.equal(bug2, false, 'variantes com char arbitrário NÃO devem match');

    // Positive: "lead_quente" E "lead quente" AINDA devem match
    const { hadHotBefore: ok1 } = computeCompraRealizadaGuards(
      ['compra_realizada'],
      ['lead_quente']
    );
    assert.equal(ok1, true, 'lead_quente ainda deve match (underscore)');

    const { hadHotBefore: ok2 } = computeCompraRealizadaGuards(
      ['compra_realizada'],
      ['lead quente']
    );
    assert.equal(ok2, true, 'lead quente ainda deve match (space)');
  });

  test('performance: 1000 labels não causa timeout', () => {
    const bigList = new Array(1000).fill('random_label');
    bigList[500] = 'lead_quente';
    const start = Date.now();
    const r = computeCompraRealizadaGuards(bigList, []);
    const elapsed = Date.now() - start;
    assert.equal(r.hasHotNow, true);
    assert.ok(elapsed < 100, `1000 labels executou em ${elapsed}ms (deve ser <100ms)`);
  });
});

describe('computeCompraRealizadaGuards — documentation consistency', () => {
  test('todos os FUNNEL_GUARD_TEST_CASES têm assertions válidas', () => {
    assert.ok(FUNNEL_GUARD_TEST_CASES.length >= 8, 'tabela deve cobrir 8+ cenários');
    for (const tc of FUNNEL_GUARD_TEST_CASES) {
      assert.equal(typeof tc.name, 'string');
      assert.ok(Array.isArray(tc.cur), `${tc.name} cur deve ser array`);
      assert.ok(Array.isArray(tc.prev), `${tc.name} prev deve ser array`);
      assert.equal(typeof tc.needLead, 'boolean');
      assert.equal(typeof tc.needCR, 'boolean');
    }
  });
});
