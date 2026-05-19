// api/_lib/emq-datasets.js
//
// Datasets monitorados pelo EMQ. Não escreve sinal, só leitura da Meta
// Dataset Quality API.

import { PIXEL_ID, PIXEL_ID_JPA, KOMMO_CAPI_DATASET } from './config.js';

function clean(value) {
  const raw = String(value || '').trim();
  return raw || null;
}

export function getEmqDatasets() {
  return [
    {
      slug: 'recife_pixel',
      label: 'Recife Pixel',
      clinic: 'recife',
      kind: 'pixel',
      datasetId: clean(PIXEL_ID),
    },
    {
      slug: 'jpa_pixel',
      label: 'JPA Pixel',
      clinic: 'jpa',
      kind: 'pixel',
      datasetId: clean(PIXEL_ID_JPA),
    },
    {
      slug: 'kommo_dataset',
      label: 'Kommo CAPI Dataset',
      clinic: 'jpa',
      kind: 'kommo',
      datasetId: clean(KOMMO_CAPI_DATASET),
    },
  ].filter(d => d.datasetId);
}
