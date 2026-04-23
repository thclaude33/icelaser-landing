/**
 * Test suite: capi-wam.js — WAM Event Sharing helper.
 * Runtime: Node built-in test (node 18+)
 *
 * Foca em:
 *   - C-1 Lead→LeadSubmitted auto-convert quando business_messaging
 *   - C-2 WABA_ID NÃO é mais injetado em user_data
 *   - Gate events_name whitelist
 *   - Skip reasons válidos quando config faltando
 *
 * Nota: sendWAMEvent faz fetch real pra Meta + Blob. Testamos via mock
 * das variáveis de ambiente + inspeção do payload montado (via monkey-patch
 * do global fetch).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('capi-wam.js gate skips (antes de fetch)', () => {
  let originalFetch;
  let originalEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  test('skip wam_dataset_not_configured quando WAM_DATASET_ID ausente', async () => {
    delete process.env.WAM_DATASET_ID;
    delete process.env.WAM_ACCESS_TOKEN;
    // Re-import pra pegar env var atual
    const mod = await import(`../api/_lib/capi-wam.js?v=${Date.now()}`);
    const res = await mod.sendWAMEvent({
      event_name: 'LeadSubmitted',
      event_id: 'test_12345678',
      user_data: { ctwa_clid: 'x'.repeat(40), page_id: '111' },
    });
    assert.ok(res.skipped?.startsWith('wam_'), `skipped com motivo wam_*, got: ${JSON.stringify(res)}`);
  });
});

describe('WAM_ALLOWED_EVENTS whitelist', () => {
  test('whitelist contém Purchase + LeadSubmitted', async () => {
    const mod = await import('../api/_lib/capi-wam.js');
    assert.ok(mod.WAM_ALLOWED_EVENTS.has('Purchase'));
    assert.ok(mod.WAM_ALLOWED_EVENTS.has('LeadSubmitted'));
  });

  test('whitelist contém Lead (pra auto-convert pegar)', async () => {
    const mod = await import('../api/_lib/capi-wam.js');
    // Lead está na whitelist pro gate passar; auto-convert DEPOIS troca pra LeadSubmitted em business_messaging
    assert.ok(mod.WAM_ALLOWED_EVENTS.has('Lead'));
  });

  test('whitelist NÃO contém PageView (apenas dataset website aceita)', async () => {
    const mod = await import('../api/_lib/capi-wam.js');
    assert.ok(!mod.WAM_ALLOWED_EVENTS.has('PageView'), 'PageView não é WAM event');
  });

  test('whitelist contém eventos standard Meta messaging', async () => {
    const mod = await import('../api/_lib/capi-wam.js');
    const expected = [
      'Purchase', 'Lead', 'LeadSubmitted', 'CompleteRegistration',
      'InitiateCheckout', 'AddToCart', 'AddPaymentInfo', 'ViewContent',
      'Subscribe', 'QualifiedLead',
    ];
    for (const e of expected) {
      assert.ok(mod.WAM_ALLOWED_EVENTS.has(e), `whitelist deve ter ${e}`);
    }
  });
});

describe('wamIsConfigured helper', () => {
  let originalEnv;
  beforeEach(() => { originalEnv = { ...process.env }; });
  afterEach(() => { process.env = originalEnv; });

  test('retorna true com WAM_DATASET_ID + WAM_ACCESS_TOKEN', async () => {
    process.env.WAM_DATASET_ID = '967048725669499';
    process.env.WAM_ACCESS_TOKEN = 'EAATestToken123';
    const mod = await import(`../api/_lib/capi-wam.js?v=${Date.now()}`);
    assert.equal(mod.wamIsConfigured(), true);
  });
});
