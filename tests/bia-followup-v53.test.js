import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAILY_MAX_SENDS,
  F1_INTERVALS_MIN,
  F1_STEPS,
  MAX_SENDS_PER_CASCADE,
  TEMPLATE_STEPS,
  computeScheduledAt,
  getFirstTemplateStepAtOrAfter,
  getNextStep,
  renderTemplate,
  scheduleCurrentStepAt,
} from '../api/_lib/cascade.js';
import {
  FOLLOWUP_CTWA_MAX_AGE_MS,
  ctwaPhoneVariants,
  getRecentCtwaContextForPhone,
  hasRecentCtwaClidForPhone,
  isRecentCtwaBlob,
} from '../api/_lib/followup-ctwa.js';
import { buildTemplatePayload } from '../api/chatwoot-bot/whatsapp.js';
import {
  buildFollowupRunLockKey,
  buildStepSendKey,
  isStateScheduledInFuture,
  isRetryableTemplateSendFailure,
  shouldSkipOverdueTemplateStep,
} from '../api/cron/bia-followup-cascade.js';

test('V5.3 F1 has the approved 16-step shadow cadence', () => {
  assert.deepEqual(
    F1_INTERVALS_MIN,
    [5, 10, 15, 21, 30, 45, 60, 90, 120, 145, 170, 195, 240, 300, 360, 450]
  );
  assert.equal(F1_STEPS.length, 16);
  assert.equal(DAILY_MAX_SENDS, 20);
  assert.equal(MAX_SENDS_PER_CASCADE, 24);
});

test('computeScheduledAt schedules F1 by offset minutes', () => {
  const startedAtMs = Date.parse('2026-05-20T20:10:00.000Z');
  assert.equal(computeScheduledAt(1, 0, startedAtMs).toISOString(), '2026-05-20T20:15:00.000Z');
  assert.equal(computeScheduledAt(1, 15, startedAtMs).toISOString(), '2026-05-21T03:40:00.000Z');
});

test('template D+1 schedule uses approved templates and BRT wall-clock times', () => {
  const startedAtMs = Date.parse('2026-05-20T20:10:00.000Z');
  assert.deepEqual(
    TEMPLATE_STEPS.slice(0, 5).map((s) => s.templateName),
    [
      'bia_d1_duvida_recife_v1',
      'bia_d1_pacotes_recife_v1',
      'bia_d1_agenda_recife_v1',
      'bia_d1_parcelas_recife_v1',
      'bia_d1_retomar_recife_v1',
    ]
  );
  assert.equal(computeScheduledAt(2, 0, startedAtMs).toISOString(), '2026-05-21T12:30:00.000Z');
  assert.equal(computeScheduledAt(2, 4, startedAtMs).toISOString(), '2026-05-21T22:30:00.000Z');
});

test('D+2 is present but disabled, so the template phase ends after D+1', () => {
  assert.equal(TEMPLATE_STEPS[5].enabled, false);
  const state = {
    phase: 2,
    step: 4,
    started_at: '2026-05-20T20:10:00.000Z',
  };
  assert.equal(getNextStep(state), null);
});

test('rescheduling an early-morning F1 step preserves spacing instead of causing a burst', () => {
  const state = {
    phase: 1,
    step: 0,
    started_at: '2026-05-20T08:00:00.000Z',
    f1_anchor_at: '2026-05-20T08:00:00.000Z',
    scheduled_at: '2026-05-20T08:05:00.000Z',
  };
  const rescheduled = scheduleCurrentStepAt(state, new Date('2026-05-20T11:00:00.000Z'));
  assert.equal(rescheduled.f1_anchor_at, '2026-05-20T10:55:00.000Z');
  assert.equal(getNextStep(rescheduled).scheduledAt.toISOString(), '2026-05-20T11:05:00.000Z');
});

test('template migration skips D+1 slots that are already in the past', () => {
  const state = {
    phase: 1,
    step: 15,
    started_at: '2026-05-20T20:10:00.000Z',
  };
  const next = getFirstTemplateStepAtOrAfter(state, Date.parse('2026-05-21T16:00:00.000Z'));
  assert.equal(next.phase, 2);
  assert.equal(next.step, 2);
  assert.equal(next.scheduledAt.toISOString(), '2026-05-21T17:30:00.000Z');
});

test('renderTemplate removes name placeholders cleanly when no name exists', () => {
  assert.equal(
    renderTemplate('{nome}, ainda faz sentido pra você? Se não for o momento, tudo bem também.', null),
    'ainda faz sentido pra você? Se não for o momento, tudo bem também.'
  );
});

test('template payload omits components when the approved template has no variables', () => {
  const payload = buildTemplatePayload({
    to: '+55 (81) 99999-0000',
    templateName: 'bia_d1_duvida_recife_v1',
  });
  assert.equal(payload.to, '5581999990000');
  assert.equal(payload.type, 'template');
  assert.equal(payload.template.name, 'bia_d1_duvida_recife_v1');
  assert.equal(Object.hasOwn(payload.template, 'components'), false);
});

test('CTWA follow-up gate generates exact 9th-digit phone variants', () => {
  assert.deepEqual(
    ctwaPhoneVariants('+55 81 98784-9015'),
    ['5581987849015', '558187849015']
  );
  assert.deepEqual(
    ctwaPhoneVariants('558187849015'),
    ['558187849015', '5581987849015']
  );
});

test('CTWA follow-up gate requires a recent ctwa_clid, not only any old blob', () => {
  const nowMs = Date.parse('2026-05-21T12:00:00.000Z');
  assert.equal(
    isRecentCtwaBlob(
      { ctwa_clid: 'clid_recent', timestamp: '2026-05-21T11:00:00.000Z' },
      {},
      nowMs
    ),
    true
  );
  assert.equal(
    isRecentCtwaBlob(
      { ctwa_clid: 'clid_old', timestamp: '2026-05-16T11:00:00.000Z' },
      {},
      nowMs
    ),
    false
  );
  assert.equal(
    isRecentCtwaBlob(
      { timestamp: '2026-05-21T11:00:00.000Z' },
      {},
      nowMs
    ),
    false
  );
});

test('hasRecentCtwaClidForPhone paginates variants and ignores stale blobs', async () => {
  const calls = [];
  const listFn = async ({ prefix, cursor }) => {
    calls.push({ prefix, cursor });
    if (prefix === 'ctwa/5581987849015' && !cursor) {
      return {
        blobs: [{ url: 'old', uploadedAt: '2026-05-16T11:00:00.000Z' }],
        hasMore: true,
        cursor: 'next',
      };
    }
    if (prefix === 'ctwa/5581987849015' && cursor === 'next') {
      return {
        blobs: [{ url: 'recent', uploadedAt: '2026-05-21T11:00:00.000Z' }],
        hasMore: false,
      };
    }
    return { blobs: [], hasMore: false };
  };
  const fetchFn = async (url) => ({
    ok: true,
    json: async () => ({
      ctwa_clid: url === 'recent' ? 'clid_recent' : 'clid_old',
      timestamp: url === 'recent' ? '2026-05-21T11:00:00.000Z' : '2026-05-16T11:00:00.000Z',
    }),
  });

  const ok = await hasRecentCtwaClidForPhone('+55 81 98784-9015', {
    listFn,
    fetchFn,
    anchorMs: Date.parse('2026-05-21T12:00:00.000Z'),
    maxAgeMs: FOLLOWUP_CTWA_MAX_AGE_MS,
  });

  assert.equal(ok, true);
  assert.deepEqual(calls.slice(0, 2), [
    { prefix: 'ctwa/5581987849015', cursor: undefined },
    { prefix: 'ctwa/5581987849015', cursor: 'next' },
  ]);
});

test('CTWA context returns the template deadline from the click timestamp', async () => {
  const ctx = await getRecentCtwaContextForPhone('5581987849015', {
    anchorMs: Date.parse('2026-05-21T12:00:00.000Z'),
    listFn: async () => ({
      blobs: [{ url: 'recent', uploadedAt: '2026-05-21T11:00:00.000Z' }],
      hasMore: false,
    }),
    fetchFn: async () => ({
      ok: true,
      json: async () => ({
        ctwa_clid: 'clid_recent',
        timestamp: '2026-05-21T11:00:00.000Z',
      }),
    }),
  });

  assert.equal(ctx.is_ctwa, true);
  assert.equal(ctx.template_free_until_at, '2026-05-24T09:00:00.000Z');
});

test('cron lock key is scoped per conversation', () => {
  assert.equal(buildFollowupRunLockKey(510), 'fu:thread:510:run_lock');
});

test('step idempotency key includes cascade start so re-arms do not collide', () => {
  const base = {
    schema_version: 3,
    phase: 1,
    step: 0,
    started_at: '2026-05-21T10:00:00.000Z',
  };
  const rearm = {
    ...base,
    started_at: '2026-05-21T18:00:00.000Z',
  };
  assert.notEqual(buildStepSendKey(510, base), buildStepSendKey(510, rearm));
  assert.match(buildStepSendKey(510, base), /^fu:thread:510:sent_step:3:\d+:1:0$/);
});

test('template backlog guard skips only overdue template steps', () => {
  assert.equal(
    shouldSkipOverdueTemplateStep(
      { phase: 2, scheduled_at: '2026-05-21T12:30:00.000Z' },
      Date.parse('2026-05-21T14:00:01.000Z')
    ),
    true
  );
  assert.equal(
    shouldSkipOverdueTemplateStep(
      { phase: 2, scheduled_at: '2026-05-21T12:30:00.000Z' },
      Date.parse('2026-05-21T13:00:00.000Z')
    ),
    false
  );
  assert.equal(
    shouldSkipOverdueTemplateStep(
      { phase: 1, scheduled_at: '2026-05-21T12:30:00.000Z' },
      Date.parse('2026-05-21T14:00:01.000Z')
    ),
    false
  );
});

test('cron due recheck skips state already advanced to the future', () => {
  assert.equal(
    isStateScheduledInFuture(
      { scheduled_at: '2026-05-21T12:31:00.000Z' },
      Date.parse('2026-05-21T12:30:00.000Z')
    ),
    true
  );
  assert.equal(
    isStateScheduledInFuture(
      { scheduled_at: '2026-05-21T12:30:00.000Z' },
      Date.parse('2026-05-21T12:30:00.000Z')
    ),
    false
  );
  assert.equal(
    isStateScheduledInFuture(
      { scheduled_at: 'not-a-date' },
      Date.parse('2026-05-21T12:30:00.000Z')
    ),
    false
  );
});

test('template send failure classifier retries only transient failures', () => {
  assert.equal(isRetryableTemplateSendFailure({ ok: false, error: 'network' }), true);
  assert.equal(isRetryableTemplateSendFailure({ ok: false, status: 429, error: { message: 'rate limit' } }), true);
  assert.equal(isRetryableTemplateSendFailure({ ok: false, status: 503, error: { message: 'unavailable' } }), true);
  assert.equal(isRetryableTemplateSendFailure({ ok: false, status: 400, error: { is_transient: true } }), true);
  assert.equal(isRetryableTemplateSendFailure({ ok: false, status: 400, error: { code: 132000 } }), false);
  assert.equal(isRetryableTemplateSendFailure({ ok: true }), false);
});
