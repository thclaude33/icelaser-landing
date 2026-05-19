import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

const originalEnv = { ...process.env };

process.env.META_PIXEL_ID = 'pixel_recife_test';
process.env.META_PIXEL_ID_JPA = 'pixel_jpa_test';
process.env.KOMMO_CAPI_DATASET_ID = 'kommo_dataset_test';

const {
  getEmqDatasets,
} = await import(`../api/_lib/emq-datasets.js?v=${Date.now()}_emq`);

after(() => {
  process.env = originalEnv;
});

describe('EMQ dataset list V5.2.1', () => {
  test('inclui Recife Pixel, JPA Pixel e Kommo dataset sem id vazio', () => {
    const datasets = getEmqDatasets();
    assert.deepEqual(datasets.map(d => d.slug), ['recife_pixel', 'jpa_pixel', 'kommo_dataset']);
    assert.equal(datasets.find(d => d.slug === 'recife_pixel').datasetId, 'pixel_recife_test');
    assert.equal(datasets.find(d => d.slug === 'jpa_pixel').datasetId, 'pixel_jpa_test');
    assert.equal(datasets.find(d => d.slug === 'kommo_dataset').datasetId, 'kommo_dataset_test');
    assert.equal(datasets.every(d => d.datasetId), true);
  });
});
