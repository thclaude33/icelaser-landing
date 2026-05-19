import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

const originalEnv = { ...process.env };

process.env.META_PIXEL_ID = 'pixel_recife_test';
process.env.META_PIXEL_ID_JPA = 'pixel_jpa_test';
process.env.META_PAGE_ID = 'page_recife_test';
process.env.META_PAGE_ID_JPA = 'page_jpa_test';
process.env.WA_PHONE_NUMBER_ID = 'phone_recife_test';
process.env.WA_PHONE_NUMBER_ID_JPA = 'phone_jpa_test';
process.env.CAPI_DATASET_TOKEN = 'token_recife_test';
process.env.CAPI_DATASET_TOKEN_JP = 'token_jpa_test';
process.env.META_ACCESS_TOKEN = 'token_meta_test';

const {
  resolveClinicFromPhoneNumberId,
  resolveClinicFromPhoneNumberIdStrict,
  resolveClinicFromPageIdStrict,
} = await import(`../api/_lib/clinic-routing.js?v=${Date.now()}_clinic`);

after(() => {
  process.env = originalEnv;
});

describe('resolveClinicFromPhoneNumberId', () => {
  test('WA_PHONE_NUMBER_ID_JPA resolve para JPA', () => {
    const clinic = resolveClinicFromPhoneNumberId('phone_jpa_test');
    assert.equal(clinic.clinic, 'jpa');
    assert.equal(clinic.city, 'joao pessoa');
    assert.equal(clinic.state, 'pb');
    assert.equal(clinic.pageId, 'page_jpa_test');
    assert.equal(clinic.pixelId, 'pixel_jpa_test');
    assert.equal(clinic.capiToken, 'token_jpa_test');
    assert.equal(clinic.isJp, true);
  });

  test('WA_PHONE_NUMBER_ID Recife resolve para Recife fallback', () => {
    const clinic = resolveClinicFromPhoneNumberId('phone_recife_test');
    assert.equal(clinic.clinic, 'recife');
    assert.equal(clinic.city, 'recife');
    assert.equal(clinic.state, 'pe');
    assert.equal(clinic.pageId, 'page_recife_test');
    assert.equal(clinic.pixelId, 'pixel_recife_test');
    assert.equal(clinic.capiToken, 'token_recife_test');
    assert.equal(clinic.isJp, false);
  });

  test('phone_number_id ausente/desconhecido usa Recife por compatibilidade legacy', () => {
    assert.equal(resolveClinicFromPhoneNumberId(null).clinic, 'recife');
    assert.equal(resolveClinicFromPhoneNumberId('unknown_phone').clinic, 'recife');
  });
});

describe('strict clinic routing V5.2.1', () => {
  test('resolveClinicFromPhoneNumberIdStrict resolve JPA/Recife e desconhecido null', () => {
    assert.equal(resolveClinicFromPhoneNumberIdStrict('phone_jpa_test').clinic, 'jpa');
    assert.equal(resolveClinicFromPhoneNumberIdStrict('phone_recife_test').clinic, 'recife');
    assert.equal(resolveClinicFromPhoneNumberIdStrict(null), null);
    assert.equal(resolveClinicFromPhoneNumberIdStrict('unknown_phone'), null);
  });

  test('resolveClinicFromPageIdStrict resolve JPA/Recife e desconhecido null', () => {
    assert.equal(resolveClinicFromPageIdStrict('page_jpa_test').clinic, 'jpa');
    assert.equal(resolveClinicFromPageIdStrict('page_recife_test').clinic, 'recife');
    assert.equal(resolveClinicFromPageIdStrict(null), null);
    assert.equal(resolveClinicFromPageIdStrict('unknown_page'), null);
  });
});
