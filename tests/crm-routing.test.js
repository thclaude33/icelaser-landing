import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  isKnownClinic,
  shouldUseChatwoot,
  shouldUseKommo,
  clinicSlug,
} = await import(`../api/_lib/crm-routing.js?v=${Date.now()}_crm`);

const recife = { clinic: 'recife', isJp: false };
const jpa = { clinic: 'jpa', isJp: true };

describe('CRM routing V5.2.1', () => {
  test('Recife usa Chatwoot e nunca Kommo', () => {
    assert.equal(isKnownClinic(recife), true);
    assert.equal(shouldUseChatwoot(recife), true);
    assert.equal(shouldUseKommo(recife), false);
    assert.equal(clinicSlug(recife), 'recife');
  });

  test('JPA usa Kommo e nunca Chatwoot', () => {
    assert.equal(isKnownClinic(jpa), true);
    assert.equal(shouldUseChatwoot(jpa), false);
    assert.equal(shouldUseKommo(jpa), true);
    assert.equal(clinicSlug(jpa), 'jpa');
  });

  test('clínica desconhecida não usa nenhum CRM', () => {
    assert.equal(isKnownClinic(null), false);
    assert.equal(shouldUseChatwoot(null), false);
    assert.equal(shouldUseKommo(null), false);
    assert.equal(clinicSlug(null), 'unknown');
  });
});
