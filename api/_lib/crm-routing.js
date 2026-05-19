// api/_lib/crm-routing.js
//
// Fonte de verdade operacional:
//   - Recife usa Chatwoot.
//   - JPA usa Kommo.
//   - Clínica desconhecida não usa CRM algum.

export function isKnownClinic(clinic) {
  return clinic?.clinic === 'recife' || clinic?.clinic === 'jpa';
}

export function shouldUseChatwoot(clinic) {
  return clinic?.clinic === 'recife';
}

export function shouldUseKommo(clinic) {
  return clinic?.clinic === 'jpa';
}

export function clinicSlug(clinic) {
  return isKnownClinic(clinic) ? clinic.clinic : 'unknown';
}
