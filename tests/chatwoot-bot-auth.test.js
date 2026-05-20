import test from 'node:test';
import assert from 'node:assert/strict';

import { checkBotInternalAuth } from '../api/chatwoot-bot.js';

const ORIGINAL_ENV = { ...process.env };

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test('chatwoot bot internal auth fails closed when token env is missing', () => {
  delete process.env.CHATWOOT_BOT_INTERNAL_TOKEN;

  const auth = checkBotInternalAuth({ headers: { 'x-bot-internal-token': 'any' } });

  assert.deepEqual(auth, {
    ok: false,
    http: 503,
    error: 'bot_misconfigured',
    mode: 'env_missing_fail_closed',
  });
});

test('chatwoot bot internal auth rejects missing or invalid token', () => {
  process.env.CHATWOOT_BOT_INTERNAL_TOKEN = 'secret-bot-token';

  assert.equal(checkBotInternalAuth({ headers: {} }).ok, false);
  assert.equal(checkBotInternalAuth({ headers: { 'x-bot-internal-token': 'wrong' } }).ok, false);
});

test('chatwoot bot internal auth accepts x-bot-internal-token', () => {
  process.env.CHATWOOT_BOT_INTERNAL_TOKEN = 'secret-bot-token';

  assert.deepEqual(
    checkBotInternalAuth({ headers: { 'x-bot-internal-token': 'secret-bot-token' } }),
    { ok: true, mode: 'x_bot_internal_token' },
  );
});
