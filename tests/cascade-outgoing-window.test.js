import test from 'node:test';
import assert from 'node:assert/strict';

import { OUTGOING_SELF_DETECT_THRESHOLD_MS } from '../api/_lib/cascade.js';

test('outgoing self-detection window matches the 5 minute marker TTL', () => {
  assert.equal(OUTGOING_SELF_DETECT_THRESHOLD_MS, 300000);
});
