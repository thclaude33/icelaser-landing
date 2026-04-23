/**
 * Test suite: purchase-routing.js
 *
 * Roteamento binário de events CRM baseado em payment_method do Chatwoot.
 * Regra Meta spec: cada evento vai pra UM dataset apenas (zero double counting):
 *   - payment_method=presencial → Pixel LP (system_generated, CRM offline)
 *   - payment_method=wa_link    → WAM (business_messaging, venda inside WhatsApp)
 *   - ctwa_clid presente sem payment_method → WAM (conversa veio de ad CTWA)
 *   - fallback → WAM (80% do volume IceLaser)
 *
 * Descoberta empírica (23/04/2026 18:30 BRT): Meta NÃO faz dedup cross-dataset
 * mesmo com mesmo event_id. Creative Testing contou 2× Purchase da Bruna
 * (R$ 2.037,60 = R$ 1.018,80 × 2 datasets). Pesquisa exaustiva confirmou
 * que não há feature Meta oficial pra cross-dataset dedup.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideTargetDataset,
  parsePurchaseValue,
  VALID_PAYMENT_METHODS,
  DATASET_PIXEL_LP,
  DATASET_WAM,
} from '../api/_lib/purchase-routing.js';

describe('decideTargetDataset — regra explícita via payment_method', () => {
  test('payment_method=presencial → Pixel LP', () => {
    const r = decideTargetDataset({ customAttrs: { payment_method: 'presencial' } });
    assert.equal(r.target, DATASET_PIXEL_LP);
    assert.equal(r.action_source, 'system_generated');
    assert.equal(r.reason, 'payment_method_presencial');
  });

  test('payment_method=wa_link SEM ctwa_clid → WAM system_generated', () => {
    // Sem ctwa_clid real, WAM rejeita business_messaging. Usa system_generated.
    const r = decideTargetDataset({ customAttrs: { payment_method: 'wa_link' } });
    assert.equal(r.target, DATASET_WAM);
    assert.equal(r.action_source, 'system_generated');
    assert.equal(r.reason, 'payment_method_wa_link');
  });

  test('payment_method=wa_link COM ctwa_clid → WAM business_messaging', () => {
    const r = decideTargetDataset({
      customAttrs: { payment_method: 'wa_link' },
      ctwa_clid: 'x'.repeat(40),
    });
    assert.equal(r.target, DATASET_WAM);
    assert.equal(r.action_source, 'business_messaging');
    assert.equal(r.reason, 'payment_method_wa_link_ctwa');
  });

  test('payment_method=outros (caso excepcional) → Pixel LP (seguro)', () => {
    const r = decideTargetDataset({ customAttrs: { payment_method: 'outros' } });
    assert.equal(r.target, DATASET_PIXEL_LP);
    assert.equal(r.action_source, 'system_generated');
  });

  test('payment_method com variação de caso (Presencial, PRESENCIAL)', () => {
    assert.equal(decideTargetDataset({ customAttrs: { payment_method: 'Presencial' } }).target, DATASET_PIXEL_LP);
    assert.equal(decideTargetDataset({ customAttrs: { payment_method: 'PRESENCIAL' } }).target, DATASET_PIXEL_LP);
    const r = decideTargetDataset({ customAttrs: { payment_method: ' WA_LINK ' } });
    assert.equal(r.target, DATASET_WAM);
    assert.equal(r.action_source, 'system_generated'); // sem ctwa_clid
  });

  test('payment_method com emoji/label Chatwoot (ex: "💰 WA Link")', () => {
    // Chatwoot às vezes adiciona emojis nos valores de atributo
    assert.equal(decideTargetDataset({ customAttrs: { payment_method: '💰 WA Link' } }).target, DATASET_WAM);
    assert.equal(decideTargetDataset({ customAttrs: { payment_method: '🏪 Presencial' } }).target, DATASET_PIXEL_LP);
  });
});

describe('decideTargetDataset — inferência automática sem payment_method', () => {
  test('ctwa_clid presente sem payment_method → WAM (veio de ad CTWA)', () => {
    const r = decideTargetDataset({ customAttrs: {}, ctwa_clid: 'Abc123'.repeat(8) });
    assert.equal(r.target, DATASET_WAM);
    assert.equal(r.action_source, 'business_messaging');
    assert.equal(r.reason, 'ctwa_clid_inferred');
  });

  test('leadgen_id presente sem payment_method → WAM system_generated', () => {
    // Lead Ad native = CRM system_generated (não messaging)
    const r = decideTargetDataset({ customAttrs: { leadgen_id: '1902453593797849' } });
    assert.equal(r.target, DATASET_WAM);
    assert.equal(r.action_source, 'system_generated');
    assert.equal(r.reason, 'leadgen_id_inferred');
  });

  test('sem payment_method, sem ctwa_clid, sem leadgen → fallback WAM system_generated', () => {
    const r = decideTargetDataset({ customAttrs: {} });
    assert.equal(r.target, DATASET_WAM);
    assert.equal(r.action_source, 'system_generated');
    assert.equal(r.reason, 'fallback_default_wam');
  });

  test('payment_method sempre tem prioridade sobre ctwa_clid', () => {
    // Se atendente marcou presencial, mesmo que tenha ctwa_clid, vai pro Pixel LP
    const r = decideTargetDataset({
      customAttrs: { payment_method: 'presencial' },
      ctwa_clid: 'Abc123'.repeat(8),
    });
    assert.equal(r.target, DATASET_PIXEL_LP);
    assert.equal(r.reason, 'payment_method_presencial');
  });
});

describe('decideTargetDataset — defensive edge cases', () => {
  test('customAttrs null/undefined → fallback WAM', () => {
    assert.equal(decideTargetDataset({ customAttrs: null }).target, DATASET_WAM);
    assert.equal(decideTargetDataset({}).target, DATASET_WAM);
    assert.equal(decideTargetDataset({ customAttrs: undefined }).target, DATASET_WAM);
  });

  test('payment_method valor inválido (ex: "asdf") → fallback inferência', () => {
    const r = decideTargetDataset({ customAttrs: { payment_method: 'asdf' } });
    // Valor inválido → ignora e usa fallback (WAM default)
    assert.equal(r.target, DATASET_WAM);
    assert.equal(r.reason, 'fallback_default_wam');
  });

  test('payment_method vazio "" → fallback', () => {
    const r = decideTargetDataset({ customAttrs: { payment_method: '' } });
    assert.equal(r.target, DATASET_WAM);
  });
});

describe('parsePurchaseValue — valor da venda', () => {
  test('número inteiro', () => {
    assert.equal(parsePurchaseValue(497), 497);
  });
  test('string com R$ e vírgula', () => {
    assert.equal(parsePurchaseValue('R$ 1.018,80'), 1018.80);
    assert.equal(parsePurchaseValue('R$599,40'), 599.40);
    assert.equal(parsePurchaseValue('1.018,80'), 1018.80);
  });
  test('string com ponto decimal (padrão US)', () => {
    assert.equal(parsePurchaseValue('497.50'), 497.50);
    assert.equal(parsePurchaseValue('1018.80'), 1018.80);
  });
  test('null/undefined/inválido → retorna null (caller decide default)', () => {
    assert.equal(parsePurchaseValue(null), null);
    assert.equal(parsePurchaseValue(undefined), null);
    assert.equal(parsePurchaseValue(''), null);
    assert.equal(parsePurchaseValue('abc'), null);
    assert.equal(parsePurchaseValue(NaN), null);
  });
  test('valor negativo → null (Meta rejeita)', () => {
    assert.equal(parsePurchaseValue(-100), null);
    assert.equal(parsePurchaseValue('-50.00'), null);
  });
  test('zero é válido (ex: brinde/cortesia)', () => {
    assert.equal(parsePurchaseValue(0), 0);
    assert.equal(parsePurchaseValue('0'), 0);
  });
});

describe('VALID_PAYMENT_METHODS — enum exportado', () => {
  test('deve conter os 3 valores esperados', () => {
    assert.ok(VALID_PAYMENT_METHODS.includes('presencial'));
    assert.ok(VALID_PAYMENT_METHODS.includes('wa_link'));
    assert.ok(VALID_PAYMENT_METHODS.includes('outros'));
    assert.equal(VALID_PAYMENT_METHODS.length, 3);
  });
});
