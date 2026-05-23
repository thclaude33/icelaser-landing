/**
 * Test suite: enrichment CTWA Kommo (api/kommo-webhook.js).
 *
 * Garante que o enrichment Kommo JP recupera atribuição CTWA do Blob
 * salvo pelo webhook WhatsApp (api/whatsapp.js → processarCTWA sendCapi:false),
 * quando o Kommo unsorted não carrega referral nativo (caso confirmado live).
 *
 * Cobertura via duas funções puras extraídas (sem mockar @vercel/blob):
 * - buildCtwaEnrichment: monta o objeto enrichment a partir de best candidate.
 * - resolveBlobTimestamp: define a "idade" do blob pra escolher o mais recente.
 *
 * + lookupCtwaBlobByPhone defensive paths (sem token, phone vazio).
 *
 * Regressão: fix(jpa) commit c7ebd80 — antes Kommo CAPI dataset ia sem
 * ctwa_clid/ad_id/etc, Andromeda perdia boost CTWA.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.BLOB_READ_WRITE_TOKEN = 'fake_blob_token';
process.env.KOMMO_CAPI_DATASET_ID = 'kommo_dataset_test';

const {
  buildCtwaEnrichment,
  resolveBlobTimestamp,
  lookupCtwaBlobByPhone,
} = await import(`../api/kommo-webhook.js?v=${Date.now()}_ctwablob`);

describe('buildCtwaEnrichment — função pura', () => {
  test('candidato completo → retorna fields + fbc reconstruído no formato Meta', () => {
    const ts = 1716422400000;
    const best = {
      ctwa_clid: 'CTWA_TEST_xyz_32_chars_aaaaaaaaaa',
      ad_id: '120211000000000001',
      adset_id: '120211000000000002',
      campaign_id: '120211000000000003',
      source_url: 'https://jpa.icelasers.com.br/',
      timestamp_ms: ts,
    };
    const result = buildCtwaEnrichment(best);
    assert.equal(result.ctwaClid, best.ctwa_clid);
    assert.equal(result.adId, best.ad_id);
    assert.equal(result.adsetId, best.adset_id);
    assert.equal(result.campaignId, best.campaign_id);
    assert.equal(result.sourceUrl, best.source_url);
    assert.equal(result.fbc, `fb.1.${ts}.${best.ctwa_clid}`);
    assert.equal(result.sourceName, 'waba_blob');
    assert.equal(result.utmSource, 'whatsapp_ad');
  });

  test('candidato null → retorna {} sem throw', () => {
    assert.deepEqual(buildCtwaEnrichment(null), {});
  });

  test('candidato sem ctwa_clid → retorna {} (treat as missing)', () => {
    assert.deepEqual(buildCtwaEnrichment({ ad_id: 'orphan' }), {});
  });

  test('candidato com timestamp_ms inválido → fbc usa Date.now() fallback', () => {
    const before = Date.now();
    const result = buildCtwaEnrichment({
      ctwa_clid: 'CLID_X',
      timestamp_ms: NaN,
    });
    const after = Date.now();
    // fbc no formato fb.1.{ts}.{clid} — extrai ts
    const fbcParts = result.fbc.split('.');
    const tsExtracted = Number(fbcParts[2]);
    assert.ok(tsExtracted >= before && tsExtracted <= after, 'ts dentro de [before, after]');
    assert.equal(fbcParts[3], 'CLID_X');
  });

  test('candidato com timestamp_ms=0 → fallback pra Date.now()', () => {
    const result = buildCtwaEnrichment({ ctwa_clid: 'CLID_Y', timestamp_ms: 0 });
    const tsExtracted = Number(result.fbc.split('.')[2]);
    assert.ok(tsExtracted > 0);
  });

  test('campos opcionais ausentes (ad_id/adset_id etc) → undefined, mas ctwaClid + fbc sempre', () => {
    const result = buildCtwaEnrichment({ ctwa_clid: 'MIN_CLID', timestamp_ms: 1000 });
    assert.equal(result.ctwaClid, 'MIN_CLID');
    assert.equal(result.fbc, 'fb.1.1000.MIN_CLID');
    assert.equal(result.adId, undefined);
    assert.equal(result.adsetId, undefined);
    assert.equal(result.sourceUrl, undefined);
  });
});

describe('resolveBlobTimestamp — escolha de "mais recente"', () => {
  test('data.timestamp ISO válido → usa esse', () => {
    const ts = resolveBlobTimestamp(
      { timestamp: '2026-05-23T01:00:00.000Z' },
      '2026-05-22T00:00:00Z',
    );
    assert.equal(ts, Date.parse('2026-05-23T01:00:00.000Z'));
  });

  test('data.timestamp inválido → fallback pra blob.uploadedAt', () => {
    const ts = resolveBlobTimestamp(
      { timestamp: 'invalid_timestamp_string' },
      '2026-05-22T10:00:00Z',
    );
    assert.equal(ts, Date.parse('2026-05-22T10:00:00Z'));
  });

  test('data.timestamp ausente → fallback pra uploadedAt', () => {
    const ts = resolveBlobTimestamp({}, '2026-05-22T10:00:00Z');
    assert.equal(ts, Date.parse('2026-05-22T10:00:00Z'));
  });

  test('ambos ausentes/inválidos → 0 (não escolhe esse blob)', () => {
    const ts = resolveBlobTimestamp({}, 'also_invalid');
    assert.equal(ts, 0);
  });

  test('data null defensivo → não throw', () => {
    const ts = resolveBlobTimestamp(null, '2026-05-22T10:00:00Z');
    assert.equal(ts, Date.parse('2026-05-22T10:00:00Z'));
  });
});

describe('lookupCtwaBlobByPhone — defensive guards', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('sem BLOB_READ_WRITE_TOKEN → retorna {} sem fetch', async () => {
    const savedToken = process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error('fetch não deveria ser chamado');
    };
    const result = await lookupCtwaBlobByPhone('5583999998888');
    assert.deepEqual(result, {});
    assert.equal(fetchCalled, false);
    process.env.BLOB_READ_WRITE_TOKEN = savedToken;
  });

  test('rawPhone vazio → {}', async () => {
    assert.deepEqual(await lookupCtwaBlobByPhone(''), {});
  });

  test('rawPhone null → {}', async () => {
    assert.deepEqual(await lookupCtwaBlobByPhone(null), {});
  });

  test('rawPhone undefined → {}', async () => {
    assert.deepEqual(await lookupCtwaBlobByPhone(undefined), {});
  });
});
