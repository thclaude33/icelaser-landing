import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchAnthropic as fetchBiaAnthropic,
  postChatwootMessage,
} from '../api/bia-session-create.js';
import {
  fetchAnthropic as fetchPostbackAnthropic,
  postChatwoot,
} from '../api/cron/bia-postback.js';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function okJsonResponse(body = { ok: true }) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('bia-session-create fetchAnthropic passes AbortSignal.timeout to fetch', async () => {
  let seen;
  globalThis.fetch = async (_url, opts) => {
    seen = opts;
    return okJsonResponse({ data: [] });
  };

  const data = await fetchBiaAnthropic('/sessions?limit=1', 1234);

  assert.deepEqual(data, { data: [] });
  assert.ok(seen.signal instanceof AbortSignal);
  assert.equal(seen.signal.aborted, false);
});

test('bia-session-create postChatwootMessage passes AbortSignal.timeout to fetch', async () => {
  let seen;
  globalThis.fetch = async (_url, opts) => {
    seen = opts;
    return okJsonResponse({ id: 123 });
  };

  const posted = await postChatwootMessage(626, 'oi', 1234);

  assert.deepEqual(posted, { id: 123 });
  assert.ok(seen.signal instanceof AbortSignal);
  assert.equal(seen.signal.aborted, false);
  assert.equal(JSON.parse(seen.body).message_type, 'outgoing');
});

test('bia-postback helpers pass AbortSignal.timeout to fetch', async () => {
  const seen = [];
  globalThis.fetch = async (_url, opts) => {
    seen.push(opts);
    return okJsonResponse({ data: [], id: 456 });
  };

  await fetchPostbackAnthropic('/sessions?limit=1', 1234);
  await postChatwoot(626, 'oi', 1234);

  assert.equal(seen.length, 2);
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.ok(seen[1].signal instanceof AbortSignal);
});

test('fetchAnthropic aborts instead of hanging when upstream never resolves', async () => {
  globalThis.fetch = async (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason || new Error('aborted')), { once: true });
  });

  try {
    await fetchBiaAnthropic('/slow', 5);
    assert.fail('expected fetchAnthropic to abort');
  } catch (err) {
    assert.match(String(err?.name || err?.message || err), /Timeout|Abort|abort/i);
  }
});
