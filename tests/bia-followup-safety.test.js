import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
  const result = validateFollowupConversation({ status: 'open', labels: ['lead_quente'] }, state);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'terminal_label');
  assert.equal(result.cleanup, true);
});

test('validateFollowupConversation blocks incoming messages after follow-up state', () => {
  const result = validateFollowupConversation({
    status: 'open',
    labels: [],
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
    labels: [],
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
