import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.META_PAGE_ID_JPA = 'page_jpa_test';
process.env.KOMMO_CAPI_DATASET_ID = 'kommo_dataset_test';

const {
  mapKommoStageToMetaEvent,
  buildLeadEvent,
} = await import(`../api/kommo-webhook.js?v=${Date.now()}_kommo`);

describe('Kommo JP stage mapping V5.2', () => {
  test('mantém primeiro contato sem Lead para não duplicar Kommo native', () => {
    assert.equal(mapKommoStageToMetaEvent('105176167'), null);
  });

  test('mantém compra realizada sem Purchase para não duplicar Kommo native', () => {
    assert.equal(mapKommoStageToMetaEvent('142'), null);
  });

  test('restaura Lead Qualificado como Qualified Lead', () => {
    assert.equal(mapKommoStageToMetaEvent('105176171'), 'Qualified Lead');
  });

  test('restaura Avaliação Comparecida como CompleteRegistration', () => {
    assert.equal(mapKommoStageToMetaEvent('105176179'), 'CompleteRegistration');
  });

  test('mantém stages custom existentes', () => {
    assert.equal(mapKommoStageToMetaEvent('105357711'), 'LeadFrio');
    assert.equal(mapKommoStageToMetaEvent('105329767'), 'InitiateCheckout');
    assert.equal(mapKommoStageToMetaEvent('105176175'), 'Schedule');
    assert.equal(mapKommoStageToMetaEvent('143'), 'LeadDesqualificado');
  });
});

describe('Kommo JP CAPI event V5.2', () => {
  test('bridge usa system_generated mesmo quando pii contém ctwaClid', () => {
    const event = buildLeadEvent({
      leadId: '123',
      eventName: 'Qualified Lead',
      dedupKey: '105176167_to_105176171',
      lead: { updated_at: Math.floor(Date.now() / 1000) },
      userData: { ph: 'hashed_phone' },
      pii: {
        ctwaClid: 'x'.repeat(40),
        hasMetaAdId: true,
        sourceName: 'waba:1104617299399194',
      },
    });

    assert.equal(event.action_source, 'system_generated');
    assert.equal(event.messaging_channel, undefined);
    assert.equal(event.event_name, 'Qualified Lead');
  });
});
