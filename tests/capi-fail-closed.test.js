/**
 * Test suite: sendCapiEvents fail-closed semantics (api/_lib/capi.js).
 *
 * Garante que silent drop (events_received=0 com status 200) e partial drop
 * (events_received < events.length) viram erro estruturado no `result.error`,
 * permitindo que callers retornem 502/422 em vez de 200 ok:true falso.
 *
 * Regressão: fix(jpa) commit c7ebd80 — antes só logava console.error e
 * retornava o result cru; callers (track.js, kommo-webhook, crm-webhook)
 * usavam `!result.error` → silent drop virava sucesso silencioso.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { sendCapiEvents } from '../api/_lib/capi.js';

const fakeEvent = (eventName = 'Lead') => ({
  event_name: eventName,
  event_time: Math.floor(Date.now() / 1000),
  action_source: 'website',
  event_id: `test_${eventName}_${Date.now()}`,
  user_data: { em: ['hash'] },
});

const mockResponse = (jsonBody, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null }, // mock pra monitorRateLimit não estourar
  json: async () => jsonBody,
  text: async () => JSON.stringify(jsonBody),
});

describe('sendCapiEvents fail-closed', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('events_received=0 com status 200 → result.error.silent_drop=true + code CAPI_ZERO_RECEIVED', async () => {
    globalThis.fetch = async () => mockResponse({
      events_received: 0,
      fbtrace_id: 'fb_trace_silent',
      messages: [],
    });
    const result = await sendCapiEvents([fakeEvent('Lead')], 'fake_token', {
      pixelId: '1234567890',
    });
    assert.equal(result.events_received, 0);
    assert.ok(result.error, 'error deve ser populado quando silent drop');
    assert.equal(result.error.code, 'CAPI_ZERO_RECEIVED');
    assert.equal(result.error.silent_drop, true);
    assert.equal(result.error.is_transient, false);
    assert.equal(result.error.events_sent, 1);
    assert.equal(result.error.events_received, 0);
  });

  test('events_received < events.length → result.error.partial_drop=true + code CAPI_PARTIAL_RECEIVED', async () => {
    globalThis.fetch = async () => mockResponse({
      events_received: 1,
      fbtrace_id: 'fb_trace_partial',
    });
    const result = await sendCapiEvents(
      [fakeEvent('Lead'), fakeEvent('Purchase')],
      'fake_token',
      { pixelId: '1234567890' },
    );
    assert.equal(result.events_received, 1);
    assert.ok(result.error, 'error populado quando partial drop');
    assert.equal(result.error.code, 'CAPI_PARTIAL_RECEIVED');
    assert.equal(result.error.partial_drop, true);
    assert.equal(result.error.events_sent, 2);
    assert.equal(result.error.events_received, 1);
  });

  test('events_received === events.length → SEM error (sucesso real)', async () => {
    globalThis.fetch = async () => mockResponse({
      events_received: 2,
      fbtrace_id: 'fb_trace_ok',
    });
    const result = await sendCapiEvents(
      [fakeEvent('Lead'), fakeEvent('Purchase')],
      'fake_token',
      { pixelId: '1234567890' },
    );
    assert.equal(result.events_received, 2);
    assert.equal(result.error, undefined, 'sem error quando entrega completa');
  });

  test('events_received undefined defaulta pra 0 (silent drop)', async () => {
    globalThis.fetch = async () => mockResponse({
      // events_received omitido — Meta às vezes devolve resposta degenerada
      fbtrace_id: 'fb_trace_undef',
    });
    const result = await sendCapiEvents([fakeEvent()], 'fake_token', {
      pixelId: '1234567890',
    });
    assert.ok(result.error, 'undefined events_received tratado como 0');
    assert.equal(result.error.code, 'CAPI_ZERO_RECEIVED');
  });

  test('error transient propagado SEM mascarar com silent_drop', async () => {
    globalThis.fetch = async () => mockResponse({
      error: {
        message: 'temporary network issue',
        code: 2,
        error_subcode: 0,
        is_transient: true,
      },
    });
    const result = await sendCapiEvents([fakeEvent()], 'fake_token', {
      pixelId: '1234567890',
    });
    assert.ok(result.error);
    assert.equal(result.error.is_transient, true, 'erro transient preservado');
    assert.notEqual(result.error.code, 'CAPI_ZERO_RECEIVED', 'não sobrescreve erro real');
  });
});
