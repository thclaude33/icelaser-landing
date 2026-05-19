import test from 'node:test';
import assert from 'node:assert/strict';

import { checkDirectAuth, safeCompare } from '../api/bia-session-create.js';

const ORIGINAL_ENV = { ...process.env };

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test('safeCompare rejects non-strings and mismatched lengths', () => {
  assert.equal(safeCompare(null, 'abc'), false);
  assert.equal(safeCompare('abc', 'abcd'), false);
  assert.equal(safeCompare('abc', 'abc'), true);
  assert.equal(safeCompare('abc', 'abd'), false);
});

test('direct path fails closed when BIA_DIRECT_API_KEY is missing', () => {
  delete process.env.BIA_DIRECT_API_KEY;

  const auth = checkDirectAuth({ headers: { authorization: 'Bearer any' } });

  assert.deepEqual(auth, {
    ok: false,
    mode: 'env_missing_fail_closed',
    http: 503,
  });
});

test('direct path rejects missing or invalid tokens', () => {
  process.env.BIA_DIRECT_API_KEY = 'secret-direct-key';

  assert.equal(checkDirectAuth({ headers: {} }).ok, false);
  assert.equal(checkDirectAuth({ headers: { authorization: 'Bearer wrong' } }).ok, false);
  assert.equal(checkDirectAuth({ headers: { 'x-api-key': 'wrong' } }).ok, false);
});

test('direct path accepts Bearer token and x-api-key', () => {
  process.env.BIA_DIRECT_API_KEY = 'secret-direct-key';

  assert.deepEqual(
    checkDirectAuth({ headers: { authorization: 'Bearer secret-direct-key' } }),
    { ok: true, mode: 'bearer' },
  );
  assert.deepEqual(
    checkDirectAuth({ headers: { 'x-api-key': 'secret-direct-key' } }),
    { ok: true, mode: 'x_api_key' },
  );
});
