/**
 * Test suite: label-change.js — Chatwoot label change detection
 *
 * Valida Fix CRITICAL 23/04/2026: detecção de label changes via
 * cached_label_list (CSV string) além de label_list (array).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLabelValue,
  normalizeChangedAttributes,
  hasLabelChange,
  extractPreviousLabels,
} from '../api/_lib/label-change.js';

describe('parseLabelValue', () => {
  test('array retorna array (filtered empty)', () => {
    assert.deepEqual(parseLabelValue(['a', 'b']), ['a', 'b']);
    assert.deepEqual(parseLabelValue(['a', '', null, 'b']), ['a', 'b']);
  });
  test('string CSV vira array', () => {
    assert.deepEqual(parseLabelValue('a,b,c'), ['a', 'b', 'c']);
    assert.deepEqual(parseLabelValue('lead_frio, from_whatsapp'), ['lead_frio', 'from_whatsapp']);
    assert.deepEqual(parseLabelValue('solo'), ['solo']);
  });
  test('string vazia retorna array vazio', () => {
    assert.deepEqual(parseLabelValue(''), []);
    assert.deepEqual(parseLabelValue(',,, '), []);
  });
  test('undefined/null retorna []', () => {
    assert.deepEqual(parseLabelValue(undefined), []);
    assert.deepEqual(parseLabelValue(null), []);
  });
});

describe('normalizeChangedAttributes', () => {
  test('array passa through', () => {
    const arr = [{ label_list: { previous_value: [], current_value: ['a'] } }];
    assert.deepEqual(normalizeChangedAttributes(arr), arr);
  });
  test('object converte pra array de entries', () => {
    const obj = { label_list: { previous_value: [] }, status: { previous_value: 'open' } };
    const result = normalizeChangedAttributes(obj);
    assert.equal(result.length, 2);
    assert.ok(result.find(a => a.label_list));
    assert.ok(result.find(a => a.status));
  });
  test('null/undefined retorna []', () => {
    assert.deepEqual(normalizeChangedAttributes(null), []);
    assert.deepEqual(normalizeChangedAttributes(undefined), []);
  });
});

describe('hasLabelChange — cobertura dos 3 formatos Chatwoot', () => {
  test('detecta label_list (array clássico Chatwoot v2)', () => {
    const ca = [{ label_list: { previous_value: [], current_value: ['lead_frio'] } }];
    assert.equal(hasLabelChange(ca), true);
  });

  test('detecta labels (legado)', () => {
    const ca = [{ labels: { previous_value: [], current_value: ['lead_frio'] } }];
    assert.equal(hasLabelChange(ca), true);
  });

  test('CRITICAL Fix 23/04: detecta cached_label_list (CSV string Chatwoot v3/v4)', () => {
    const ca = [
      { updated_at: { previous_value: '2026-04-23T14:50:48.258Z', current_value: '2026-04-23T14:50:50.677Z' } },
      { cached_label_list: { previous_value: 'from_whatsapp', current_value: 'from_whatsapp,lead_frio' } },
    ];
    assert.equal(hasLabelChange(ca), true, 'cached_label_list DEVE ser detectado');
  });

  test('detecta cached_label_list mesmo com previous/current vazios', () => {
    const ca = [{ cached_label_list: { previous_value: '', current_value: 'lead_quente' } }];
    assert.equal(hasLabelChange(ca), true);
  });

  test('skipa quando só updated_at/first_reply_created_at mudaram', () => {
    const ca = [
      { updated_at: { previous_value: 'a', current_value: 'b' } },
      { first_reply_created_at: { previous_value: null, current_value: '2026-04-23T14:50:48.258Z' } },
    ];
    assert.equal(hasLabelChange(ca), false, 'sem label change → false');
  });

  test('skipa quando array vazio', () => {
    assert.equal(hasLabelChange([]), false);
    assert.equal(hasLabelChange(null), false);
    assert.equal(hasLabelChange(undefined), false);
  });

  test('accepta changed_attributes como object (não array)', () => {
    const obj = { cached_label_list: { previous_value: '', current_value: 'lead_frio' } };
    assert.equal(hasLabelChange(obj), true);
  });
});

describe('extractPreviousLabels — cobertura dos 3 formatos', () => {
  test('extrai array de label_list.previous_value', () => {
    const ca = [{ label_list: { previous_value: ['from_whatsapp', 'hot_lead'], current_value: [] } }];
    assert.deepEqual(extractPreviousLabels(ca), ['from_whatsapp', 'hot_lead']);
  });

  test('CRITICAL: extrai labels do CSV cached_label_list.previous_value', () => {
    const ca = [{ cached_label_list: { previous_value: 'from_whatsapp,hot_lead', current_value: 'from_whatsapp,hot_lead,compra_realizada' } }];
    assert.deepEqual(extractPreviousLabels(ca), ['from_whatsapp', 'hot_lead']);
  });

  test('cached_label_list com espaços no CSV', () => {
    const ca = [{ cached_label_list: { previous_value: 'from_whatsapp, lead_frio ', current_value: 'from_whatsapp, lead_frio, lead_quente' } }];
    assert.deepEqual(extractPreviousLabels(ca), ['from_whatsapp', 'lead_frio']);
  });

  test('retorna [] quando previous_value é string vazia', () => {
    const ca = [{ cached_label_list: { previous_value: '', current_value: 'lead_frio' } }];
    assert.deepEqual(extractPreviousLabels(ca), []);
  });

  test('retorna [] quando não há label change', () => {
    const ca = [{ updated_at: { previous_value: 'a', current_value: 'b' } }];
    assert.deepEqual(extractPreviousLabels(ca), []);
  });
});

describe('REGRESSÃO Q3 (bug 23/04 14:50 UTC): gerente marcando labels sem CAPI disparar', () => {
  test('payload exato observado em produção: cached_label_list only → DEVE disparar', () => {
    // Reprodução LIVE do payload Chatwoot observado nos logs 14:50-14:51 UTC:
    //   changed_attributes=[{"updated_at":{...}},{"cached_label_list":{"previous_value":"from_whatsapp","current_value":"from_whatsapp,lead_frio"}}]
    const payload = [
      { updated_at: { previous_value: '2026-04-23T14:50:48.258Z', current_value: '2026-04-23T14:50:50.677Z' } },
      { cached_label_list: { previous_value: 'from_whatsapp', current_value: 'from_whatsapp,lead_frio' } },
    ];
    assert.equal(hasLabelChange(payload), true, 'PROD payload deve triggar CAPI');
    assert.deepEqual(extractPreviousLabels(payload), ['from_whatsapp']);
  });

  test('nova label lead_quente: current diff previous dá novos labels corretos', () => {
    const payload = [
      { cached_label_list: { previous_value: 'from_whatsapp,lead_frio', current_value: 'from_whatsapp,lead_frio,lead_quente' } },
    ];
    const prev = extractPreviousLabels(payload);
    const current = ['from_whatsapp', 'lead_frio', 'lead_quente'];
    const newLabels = current.filter(l => !prev.includes(l));
    assert.deepEqual(newLabels, ['lead_quente']);
  });

  test('compra_realizada adicionado após lead_quente: só compra_realizada é novo', () => {
    const payload = [
      { cached_label_list: { previous_value: 'from_whatsapp,lead_quente', current_value: 'from_whatsapp,lead_quente,compra_realizada' } },
    ];
    const prev = extractPreviousLabels(payload);
    const current = ['from_whatsapp', 'lead_quente', 'compra_realizada'];
    const newLabels = current.filter(l => !prev.includes(l));
    assert.deepEqual(newLabels, ['compra_realizada'], 'só compra_realizada é novo, lead_quente já existia');
  });
});
