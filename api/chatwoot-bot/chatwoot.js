/**
 * Chatwoot Railway API helpers (Recife)
 *
 * Endpoints úteis:
 *   GET    /api/v1/accounts/{aid}/conversations/{cid}
 *   POST   /api/v1/accounts/{aid}/conversations/{cid}/labels
 *   POST   /api/v1/accounts/{aid}/conversations/{cid}/custom_attributes
 *   POST   /api/v1/accounts/{aid}/conversations/{cid}/assignments
 *
 * Auth: header `api_access_token`. NÃO usar bearer (formato Chatwoot-específico).
 *
 * DRY-RUN: se process.env.CHATWOOT_BOT_DRY_RUN === '1', NÃO modifica nada — só
 * loga a operação que seria feita. Pra smoke test sem afetar conversa real.
 */

const CW_URL = 'https://chatwoot-production-af5f.up.railway.app';
const CW_ACCOUNT = '1';
const CW_TOKEN = process.env.CHATWOOT_API_TOKEN || 'xcEaME3WLizkocorjScunW7D';

function isDryRun() {
  return process.env.CHATWOOT_BOT_DRY_RUN === '1';
}

/**
 * GET conversation details
 */
export async function getConversation(conversationId) {
  if (!conversationId) return { ok: false, error: 'no_conversation_id' };
  const url = `${CW_URL}/api/v1/accounts/${CW_ACCOUNT}/conversations/${conversationId}`;
  try {
    const res = await fetch(url, { headers: { 'api_access_token': CW_TOKEN } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`[CW-BOT] getConversation ${conversationId} HTTP ${res.status}: ${body}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    console.error(`[CW-BOT] getConversation ${conversationId} network:`, e.message);
    return { ok: false, error: 'network', detail: e.message };
  }
}

/**
 * Add labels to a conversation. Labels are MERGED com as existentes (não substitui).
 * NÃO usa POST /labels — esse SUBSTITUI lista. Em vez disso lê labels atuais + PATCH.
 *
 * Mas Chatwoot v4.x tem endpoint POST /labels que ADICIONA. Vamos usar.
 *
 * @param {number} conversationId
 * @param {string[]} labels - títulos das labels (precisam existir)
 */
export async function addLabels(conversationId, labels) {
  if (!conversationId) return { ok: false, error: 'no_conversation_id' };
  if (!Array.isArray(labels) || !labels.length) return { ok: true, skipped: true };

  if (isDryRun()) {
    console.log(`[CW-BOT DRY-RUN] addLabels conv=${conversationId} labels=${JSON.stringify(labels)}`);
    return { ok: true, dryRun: true };
  }

  // Chatwoot v4.x: POST /labels com body { labels: [...] } SUBSTITUI a lista.
  // Pra ADICIONAR sem perder existentes: GET conversa → merge → POST.
  const conv = await getConversation(conversationId);
  if (!conv.ok) return conv;

  const existingLabels = conv.data?.labels || [];
  const merged = Array.from(new Set([...existingLabels, ...labels]));

  const url = `${CW_URL}/api/v1/accounts/${CW_ACCOUNT}/conversations/${conversationId}/labels`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': CW_TOKEN },
      body: JSON.stringify({ labels: merged }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`[CW-BOT] addLabels ${conversationId} HTTP ${res.status}: ${body}`);
      return { ok: false, status: res.status };
    }
    console.log(`[CW-BOT] addLabels conv=${conversationId} added=${labels.join(',')}`);
    return { ok: true };
  } catch (e) {
    console.error(`[CW-BOT] addLabels network:`, e.message);
    return { ok: false, error: 'network', detail: e.message };
  }
}

/**
 * Set custom attributes na conversation (bot_step, bot_pacote, bot_active)
 *
 * @param {number} conversationId
 * @param {Object} attrs - {bot_step: 1, bot_pacote: 'p1', bot_active: true}
 */
export async function setCustomAttributes(conversationId, attrs) {
  if (!conversationId) return { ok: false, error: 'no_conversation_id' };
  if (!attrs || typeof attrs !== 'object') return { ok: true, skipped: true };

  if (isDryRun()) {
    console.log(`[CW-BOT DRY-RUN] setCustomAttributes conv=${conversationId} attrs=${JSON.stringify(attrs)}`);
    return { ok: true, dryRun: true };
  }

  const url = `${CW_URL}/api/v1/accounts/${CW_ACCOUNT}/conversations/${conversationId}/custom_attributes`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': CW_TOKEN },
      body: JSON.stringify({ custom_attributes: attrs }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`[CW-BOT] setCustomAttributes ${conversationId} HTTP ${res.status}: ${body}`);
      return { ok: false, status: res.status };
    }
    console.log(`[CW-BOT] setCustomAttributes conv=${conversationId} attrs=${JSON.stringify(attrs)}`);
    return { ok: true };
  } catch (e) {
    console.error(`[CW-BOT] setCustomAttributes network:`, e.message);
    return { ok: false, error: 'network', detail: e.message };
  }
}

/**
 * GET contact details (pra checar custom_attributes do contato)
 */
export async function getContact(contactId) {
  if (!contactId) return { ok: false, error: 'no_contact_id' };
  const url = `${CW_URL}/api/v1/accounts/${CW_ACCOUNT}/contacts/${contactId}`;
  try {
    const res = await fetch(url, { headers: { 'api_access_token': CW_TOKEN } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`[CW-BOT] getContact ${contactId} HTTP ${res.status}: ${body}`);
      return { ok: false, status: res.status };
    }
    const json = await res.json();
    // Chatwoot envelope: { payload: {...} }
    return { ok: true, data: json?.payload || json };
  } catch (e) {
    console.error(`[CW-BOT] getContact ${contactId} network:`, e.message);
    return { ok: false, error: 'network', detail: e.message };
  }
}

/**
 * Update contact custom_attributes (merge — não substitui outros).
 * Usado pra marcar bot_welcomed=true após primeiro welcome.
 */
export async function updateContactCustomAttributes(contactId, attrs) {
  if (!contactId) return { ok: false, error: 'no_contact_id' };
  if (!attrs || typeof attrs !== 'object') return { ok: true, skipped: true };

  if (isDryRun()) {
    console.log(`[CW-BOT DRY-RUN] updateContactCustomAttributes contact=${contactId} attrs=${JSON.stringify(attrs)}`);
    return { ok: true, dryRun: true };
  }

  // Ler attrs atuais pra merge (não substituir outros campos)
  const cur = await getContact(contactId);
  const currentAttrs = cur.ok ? (cur.data?.custom_attributes || {}) : {};
  const merged = { ...currentAttrs, ...attrs };

  const url = `${CW_URL}/api/v1/accounts/${CW_ACCOUNT}/contacts/${contactId}`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api_access_token': CW_TOKEN },
      body: JSON.stringify({ custom_attributes: merged }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`[CW-BOT] updateContact ${contactId} HTTP ${res.status}: ${body}`);
      return { ok: false, status: res.status };
    }
    console.log(`[CW-BOT] updateContact ${contactId} attrs=${JSON.stringify(attrs)}`);
    return { ok: true };
  } catch (e) {
    console.error(`[CW-BOT] updateContact network:`, e.message);
    return { ok: false, error: 'network', detail: e.message };
  }
}

/**
 * Extrai contact_id do payload Chatwoot
 */
export function extractContactId(payload) {
  return (
    payload?.meta?.sender?.id ||
    payload?.sender?.id ||
    payload?.conversation?.meta?.sender?.id ||
    payload?.contact?.id ||
    payload?.contact_id ||
    null
  );
}

/**
 * Extrai phone number do payload Chatwoot (suporta diferentes formatos)
 */
export function extractPhone(payload) {
  return (
    payload?.meta?.sender?.phone_number ||
    payload?.sender?.phone_number ||
    payload?.conversation?.meta?.sender?.phone_number ||
    payload?.contact?.phone_number ||
    null
  );
}

/**
 * Extrai inbox_id do payload Chatwoot
 */
export function extractInboxId(payload) {
  return (
    payload?.inbox_id ||
    payload?.inbox?.id ||
    payload?.conversation?.inbox_id ||
    null
  );
}

/**
 * Extrai conversation_id do payload Chatwoot
 */
export function extractConversationId(payload) {
  return (
    payload?.id ||                  // payload é a própria conversation
    payload?.conversation?.id ||
    payload?.conversation_id ||
    null
  );
}
