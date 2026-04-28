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

/**
 * Issue 2 (PR follow-up /review 38) — 5 cenários da decisão action_source.
 * Cobre todos os branches do switch implementado em capi-wam.js linhas ~219-234:
 *   1. Auto-convert Lead → LeadSubmitted ANTES da decisão action_source (implícito BM via ctwa)
 *   2. Fallback system_generated quando event_name NÃO no BUSINESS_MESSAGING_VALID
 *   3. Caller system_generated explícito é respeitado (mesmo c/ ctwa presente)
 *   4. Caller business_messaging explícito + Lead → auto-convert + BM
 *   5. Caller business_messaging explícito + Subscribe → fallback system_generated
 *
 * + 2 cenários defensivos das Issues 3 e 5:
 *   6. Issue 5: 'Lead ' (com whitespace) é trim+auto-converted
 *   7. Issue 3: 'BUSINESS_MESSAGING' (uppercase) é normalizado p/ lowercase
 */
describe('action_source decision logic (Issue 2 / Issues 3+5 defensive)', () => {
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

  test('cenário 1: Lead implícito BM (ctwa presente, sem action_source) → auto-convert + BM', async () => {
    const mod = await import(`../api/_lib/capi-wam.js?v=${Date.now()}_s1`);
    const fakeCtwa = 'x'.repeat(40);
    await mod.sendWAMEvent({
      event_name: 'Lead',
      event_id: 'test_scenario_1',
      user_data: { ctwa_clid: fakeCtwa, page_id: '111', ph: ['hashed'] },
      // sem action_source — caller implícito BM via ctwa_clid
    });
    assert.ok(capturedBody, 'fetch foi chamado');
    assert.equal(capturedBody.data[0].event_name, 'LeadSubmitted', 'Lead → LeadSubmitted');
    assert.equal(capturedBody.data[0].action_source, 'business_messaging');
    assert.equal(capturedBody.data[0].messaging_channel, 'whatsapp');
  });

  test('cenário 2: CompleteRegistration implícito BM → fallback system_generated (event não na BM whitelist)', async () => {
    const mod = await import(`../api/_lib/capi-wam.js?v=${Date.now()}_s2`);
    const fakeCtwa = 'x'.repeat(40);
    await mod.sendWAMEvent({
      event_name: 'CompleteRegistration',
      event_id: 'test_scenario_2',
      user_data: { ctwa_clid: fakeCtwa, page_id: '111', ph: ['hashed'] },
    });
    assert.ok(capturedBody);
    assert.equal(capturedBody.data[0].event_name, 'CompleteRegistration', 'event_name preservado');
    assert.equal(capturedBody.data[0].action_source, 'system_generated', 'fallback aplicado');
    assert.equal(capturedBody.data[0].messaging_channel, undefined, 'sem messaging_channel em system_generated');
    // ctwa_clid preservado pra atribuição via Meta lookback 7d
    assert.equal(capturedBody.data[0].user_data.ctwa_clid, fakeCtwa, 'ctwa_clid preservado em system_generated');
  });

  test('cenário 3: caller system_generated explícito é respeitado (mesmo com ctwa)', async () => {
    const mod = await import(`../api/_lib/capi-wam.js?v=${Date.now()}_s3`);
    const fakeCtwa = 'x'.repeat(40);
    await mod.sendWAMEvent({
      event_name: 'Purchase',
      event_id: 'test_scenario_3',
      user_data: { ctwa_clid: fakeCtwa, ph: ['hashed'], external_id: ['hashed_ext'] },
      custom_data: { currency: 'BRL', value: 497 },
      action_source: 'system_generated',
    });
    assert.ok(capturedBody);
    assert.equal(capturedBody.data[0].action_source, 'system_generated');
    // event_name 'Purchase' está na BM whitelist mas caller forçou system_generated → respeita
    assert.equal(capturedBody.data[0].event_name, 'Purchase', 'sem auto-convert em system_generated');
  });

  test('cenário 4: caller business_messaging explícito + Lead → auto-convert + BM', async () => {
    const mod = await import(`../api/_lib/capi-wam.js?v=${Date.now()}_s4`);
    const fakeCtwa = 'x'.repeat(40);
    await mod.sendWAMEvent({
      event_name: 'Lead',
      event_id: 'test_scenario_4',
      user_data: { ctwa_clid: fakeCtwa, page_id: '111', ph: ['hashed'] },
      action_source: 'business_messaging',
    });
    assert.ok(capturedBody);
    assert.equal(capturedBody.data[0].event_name, 'LeadSubmitted', 'Lead → LeadSubmitted (explicit BM)');
    assert.equal(capturedBody.data[0].action_source, 'business_messaging');
  });

  test('cenário 5: caller business_messaging explícito + Subscribe → fallback system_generated', async () => {
    const mod = await import(`../api/_lib/capi-wam.js?v=${Date.now()}_s5`);
    const fakeCtwa = 'x'.repeat(40);
    await mod.sendWAMEvent({
      event_name: 'Subscribe',
      event_id: 'test_scenario_5',
      user_data: { ctwa_clid: fakeCtwa, page_id: '111', ph: ['hashed'] },
      action_source: 'business_messaging',
    });
    assert.ok(capturedBody);
    assert.equal(capturedBody.data[0].event_name, 'Subscribe', 'event_name preservado');
    // Subscribe NÃO está em BUSINESS_MESSAGING_VALID → fallback
    assert.equal(capturedBody.data[0].action_source, 'system_generated', 'Subscribe não suportado em BM');
  });

  test('Issue 5 defensive: event_name "Lead " (whitespace trailing) é trim+auto-converted', async () => {
    const mod = await import(`../api/_lib/capi-wam.js?v=${Date.now()}_i5`);
    const fakeCtwa = 'x'.repeat(40);
    const res = await mod.sendWAMEvent({
      event_name: 'Lead ', // whitespace trailing — antes do fix bypass silencioso
      event_id: 'test_issue_5',
      user_data: { ctwa_clid: fakeCtwa, page_id: '111', ph: ['hashed'] },
      action_source: 'business_messaging',
    });
    assert.ok(capturedBody, `fetch chamado (não rejeitado upstream); res=${JSON.stringify(res)}`);
    assert.equal(capturedBody.data[0].event_name, 'LeadSubmitted', 'trim+auto-convert pegou Lead com space');
    assert.equal(capturedBody.data[0].action_source, 'business_messaging');
  });

  test('Issue 3 defensive: action_source "BUSINESS_MESSAGING" (uppercase) é normalizado', async () => {
    const mod = await import(`../api/_lib/capi-wam.js?v=${Date.now()}_i3`);
    const fakeCtwa = 'x'.repeat(40);
    await mod.sendWAMEvent({
      event_name: 'LeadSubmitted',
      event_id: 'test_issue_3',
      user_data: { ctwa_clid: fakeCtwa, page_id: '111', ph: ['hashed'] },
      action_source: 'BUSINESS_MESSAGING', // uppercase — antes ia pra system_generated silencioso
    });
    assert.ok(capturedBody);
    assert.equal(capturedBody.data[0].action_source, 'business_messaging', 'normalizado p/ lowercase');
  });
});
