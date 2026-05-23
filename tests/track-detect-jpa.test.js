/**
 * Test suite: detectJpRequest helper (api/track.js).
 *
 * Garante que o roteamento Pixel JPA vs Recife funciona em todos os cenários
 * onde a Origin pode estar ausente: keepalive/beacon, server-to-server, preview
 * deploys vercel.app, iframe sandbox. Helper deve usar event_source_url e
 * landing_url do body como fonte alternativa.
 *
 * Regressão: fix(jpa) commit c7ebd80 — antes routing era só `getPixelByHost(originHost)`,
 * caía pra Pixel Recife default sempre que Origin faltava.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { detectJpRequest } = await import(`../api/track.js?v=${Date.now()}_detect`);

const fakeReq = (headers = {}) => ({ headers });

describe('detectJpRequest — múltiplos sinais', () => {
  test('Origin jpa.icelasers.com.br → true', () => {
    assert.equal(
      detectJpRequest(fakeReq({ origin: 'https://jpa.icelasers.com.br' }), {}),
      true,
    );
  });

  test('Origin Recife sem nenhum sinal JPA → false', () => {
    assert.equal(
      detectJpRequest(fakeReq({ origin: 'https://icelasers.com.br' }), {}),
      false,
    );
  });

  test('Origin AUSENTE + event_source_url JPA no body → true (keepalive/beacon path)', () => {
    assert.equal(
      detectJpRequest(fakeReq(), { event_source_url: 'https://jpa.icelasers.com.br/' }),
      true,
    );
  });

  test('Origin AUSENTE + landing_url JPA → true (server-to-server path)', () => {
    assert.equal(
      detectJpRequest(fakeReq(), { landing_url: 'https://jpa.icelasers.com.br/v2/' }),
      true,
    );
  });

  test('Origin Recife + landing_url JPA → true (qualquer sinal positivo basta)', () => {
    assert.equal(
      detectJpRequest(
        fakeReq({ origin: 'https://icelasers.com.br' }),
        { landing_url: 'https://jpa.icelasers.com.br/' },
      ),
      true,
    );
  });

  test('Referer JPA com Origin vazio → true', () => {
    assert.equal(
      detectJpRequest(fakeReq({ referer: 'https://jpa.icelasers.com.br/v2/' }), {}),
      true,
    );
  });

  test('x-forwarded-host JPA (Vercel proxy) → true', () => {
    assert.equal(
      detectJpRequest(fakeReq({ 'x-forwarded-host': 'jpa.icelasers.com.br' }), {}),
      true,
    );
  });

  test('host header JPA quando outros faltam → true', () => {
    assert.equal(
      detectJpRequest(fakeReq({ host: 'jpa.icelasers.com.br' }), {}),
      true,
    );
  });

  test('keyword "bancarios" no path → true (LP slug pattern)', () => {
    assert.equal(
      detectJpRequest(fakeReq(), { event_source_url: 'https://lp.icelasers.com.br/bancarios' }),
      true,
    );
  });

  test('keyword "jp-routing" → true (proxy/audit path)', () => {
    assert.equal(
      detectJpRequest(fakeReq({ referer: 'https://app.example.com/jp-routing/x' }), {}),
      true,
    );
  });

  test('todos sinais ausentes → false (default Recife)', () => {
    assert.equal(detectJpRequest(fakeReq(), {}), false);
  });

  test('req undefined defensivamente → false (não throw)', () => {
    assert.equal(detectJpRequest(undefined, {}), false);
  });

  test('body undefined defensivamente → false (não throw)', () => {
    assert.equal(detectJpRequest(fakeReq(), undefined), false);
  });

  test('case-insensitive — JPA.ICELASERS.COM.BR → true', () => {
    assert.equal(
      detectJpRequest(fakeReq({ origin: 'HTTPS://JPA.ICELASERS.COM.BR' }), {}),
      true,
    );
  });

  test('domínio parecido mas não JPA — jpaa.icelasers.com.br → true (overinclusive)', () => {
    // Aceitável: prefere falsos positivos JPA a falsos negativos. Pior caso
    // = evento Recife caindo em Pixel JPA (volume baixo). Cobertura de
    // sinal é intencional.
    assert.equal(
      detectJpRequest(fakeReq({ origin: 'https://jpaa.icelasers.com.br' }), {}),
      true,
    );
  });
});
