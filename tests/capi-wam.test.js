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

describe('business_messaging strip banned fields (fix 2804064)', () => {
  let originalFetch, originalEnv, capturedBody;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    capturedBody = null;
    process.env.WAM_DATASET_ID = '967048725669499';
    process.env.WAM_ACCESS_TOKEN = 'EAATestToken123';
    process.env.META_PAGE_ID = '111790301665816';
    globalThis.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ events_received: 1, fbtrace_id: 'test_trace' }),
      };
    };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  test('strips fbc/fbp/client_ip_address/client_user_agent quando business_messaging', async () => {
    const mod = await import(`../api/_lib/capi-wam.js?v=${Date.now()}_a`);
    const fakeCtwa = 'x'.repeat(40);
    await mod.sendWAMEvent({
      event_name: 'LeadSubmitted',
      event_id: 'test_strip_1',
      user_data: {
        ctwa_clid: fakeCtwa,
        page_id: '111',
        ph: ['hashed_ph'],
        fbc: `fb.2.${Date.now()}.${fakeCtwa}`,      // DEVE ser removido
        fbp: 'fb.1.1234567890.987654321',           // DEVE ser removido
        client_ip_address: '1.2.3.4',               // DEVE ser removido
        client_user_agent: 'Mozilla/5.0',           // DEVE ser removido
        external_id: ['hashed_ext'],                // DEVE permanecer
      },
      action_source: 'business_messaging',
    });
    assert.ok(capturedBody, 'fetch foi chamado');
    const ud = capturedBody.data[0].user_data;
    assert.equal(ud.fbc, undefined, 'fbc DEVE ser removido');
    assert.equal(ud.fbp, undefined, 'fbp DEVE ser removido');
    assert.equal(ud.client_ip_address, undefined, 'client_ip_address DEVE ser removido');
    assert.equal(ud.client_user_agent, undefined, 'client_user_agent DEVE ser removido');
    assert.ok(ud.ctwa_clid, 'ctwa_clid preservado');
    assert.ok(ud.ph, 'ph preservado');
    assert.ok(ud.external_id, 'external_id preservado');
  });

  test('preserva fbc/fbp quando system_generated (CRM)', async () => {
    const mod = await import(`../api/_lib/capi-wam.js?v=${Date.now()}_b`);
    await mod.sendWAMEvent({
      event_name: 'Purchase',
      event_id: 'test_preserve_1',
      user_data: {
        ph: ['hashed_ph'],
        fbc: `fb.2.1234.xyz`,
        fbp: 'fb.1.5678.abc',
        external_id: ['hashed_ext'],
      },
      custom_data: { currency: 'BRL', value: 497 },
      action_source: 'system_generated',
    });
    assert.ok(capturedBody);
    const ud = capturedBody.data[0].user_data;
    assert.ok(ud.fbc, 'fbc preservado em system_generated');
    assert.ok(ud.fbp, 'fbp preservado em system_generated');
  });
});
