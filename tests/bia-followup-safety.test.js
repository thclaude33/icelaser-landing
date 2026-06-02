import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchChatwootConversation,
  isKvWriteDegraded,
  normalizeChatwootLabels,
  validateFollowupConversation,
} from '../api/cron/bia-followup-cascade.js';

const state = {
  started_at: '2026-05-19T12:00:00.000Z',
  last_step_sent_at: '2026-05-19T12:10:00.000Z',
};

test('normalizeChatwootLabels reads arrays and cached_label_list CSV', () => {
  assert.deepEqual(
    normalizeChatwootLabels({
      labels: ['BIA_TESTE'],
      cached_label_list: 'lead_quente, compra_realizada',
    }),
    ['bia_teste', 'lead_quente', 'compra_realizada'],
  );
});

test('validateFollowupConversation blocks non-open conversations', () => {
  const result = validateFollowupConversation({ status: 'resolved', labels: [] }, state);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'status_not_open');
  assert.equal(result.cleanup, true);
});

test('validateFollowupConversation blocks terminal labels', () => {
  const result = validateFollowupConversation({ status: 'open', labels: ['bia_teste', 'desqualificado'] }, state);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'terminal_label');
  assert.equal(result.cleanup, true);
});

test('validateFollowupConversation blocks incoming messages after follow-up state', () => {
  const result = validateFollowupConversation({
    status: 'open',
    labels: ['bia_teste'],
    messages: [
      { id: 1, message_type: 0, created_at: '2026-05-19T12:11:00.000Z' },
    ],
  }, state);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'incoming_after_followup_state');
});

test('validateFollowupConversation blocks human outgoing messages after follow-up state', () => {
  const result = validateFollowupConversation({
    status: 'open',
    labels: ['bia_teste'],
    messages: [
      { id: 2, message_type: 1, created_at: '2026-05-19T12:11:00.000Z', sender: { type: 'user' } },
    ],
  }, state);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'human_outgoing_after_followup_state');
});

test('validateFollowupConversation allows open conversation without new human activity', () => {
  const result = validateFollowupConversation({
    status: 'open',
    labels: ['bia_teste'],
    messages: [
      { id: 1, message_type: 0, created_at: '2026-05-19T12:00:00.000Z' },
      { id: 2, message_type: 1, created_at: '2026-05-19T12:05:00.000Z', sender: null },
    ],
  }, state);

  assert.equal(result.ok, true);
});

test('isKvWriteDegraded catches fail-open fallback responses', () => {
  assert.equal(isKvWriteDegraded({ ok: true }), false);
  assert.equal(isKvWriteDegraded({ ok: true, fallback: true }), true);
  assert.equal(isKvWriteDegraded({ ok: false }), true);
  assert.equal(isKvWriteDegraded(undefined), true);
});

test('fetchChatwootConversation uses messages index, not only show last message', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/conversations/123')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          payload: {
            id: 123,
            status: 'open',
            labels: ['bia_teste'],
            messages: [
              { id: 99, message_type: 2, created_at: 1779192720 },
            ],
          },
        }),
      };
    }
    if (String(url).endsWith('/conversations/123/messages')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          payload: [
            { id: 98, message_type: 0, created_at: 1779192660 },
            { id: 99, message_type: 2, created_at: 1779192720 },
          ],
        }),
      };
    }
    throw new Error(`unexpected url ${url}`);
  };

  try {
    const result = await fetchChatwootConversation('123');

    assert.equal(result.ok, true);
    assert.deepEqual(result.conversation.messages.map((m) => m.id), [98, 99]);
    assert.equal(calls.some((url) => url.endsWith('/conversations/123/messages')), true);
    assert.equal(
      validateFollowupConversation(result.conversation, { last_step_sent_at: '2026-05-19T03:30:00.000Z' }).reason,
      'incoming_after_followup_state',
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchChatwootConversation returns network errors instead of throwing', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  try {
    const result = await fetchChatwootConversation('123');

    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.network_error, true);
    assert.match(result.detail, /ECONNREFUSED/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('validateFollowupConversation allows lead_quente when bia_teste is present', () => {
  const result = validateFollowupConversation({
    status: 'open',
    labels: ['bia_teste', 'lead_quente'],
    messages: [],
  }, state);

  assert.equal(result.ok, true);
});

test('validateFollowupConversation disarms when bia_teste was removed (cron backstop)', () => {
  // Remoção de bia_teste = desarme: o cron busca a conversa, vê que não tem mais bia_teste e
  // limpa, mesmo se o webhook perdeu o evento. Supersede a lógica de label terminal.
  const result = validateFollowupConversation({
    status: 'open',
    labels: ['lead_quente'],
    messages: [],
  }, state);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bia_teste_removed');
  assert.equal(result.cleanup, true);
});

test('validateFollowupConversation still blocks compra_realizada even with bia_teste', () => {
  const result = validateFollowupConversation({
    status: 'open',
    labels: ['bia_teste', 'compra_realizada'],
    messages: [],
  }, state);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'terminal_label');
  assert.equal(result.label, 'compra_realizada');
});
