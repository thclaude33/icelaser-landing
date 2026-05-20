import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSkillVersionInSync,
  selectLatestSkillVersion,
} from '../api/cron/bia-skill-refresh.js';

test('selectLatestSkillVersion sorts by created_at desc, not API order', () => {
  const latest = selectLatestSkillVersion([
    { id: 'skill_version_old', version: '100', created_at: '2026-05-13T02:05:28.139976Z' },
    { id: 'skill_version_new', version: '400', created_at: '2026-05-13T07:19:39.487841Z' },
    { id: 'skill_version_mid', version: '200', created_at: '2026-05-13T05:30:54.650117Z' },
  ]);

  assert.equal(latest.id, 'skill_version_new');
});

test('isSkillVersionInSync compares version ids, not numeric version fields', () => {
  const latest = {
    id: 'skill_version_01NnoxQUzssX6xPVdy65aJjp',
    version: '1778656778530150',
  };

  assert.equal(isSkillVersionInSync('skill_version_01NnoxQUzssX6xPVdy65aJjp', latest), true);
  assert.equal(isSkillVersionInSync('1778656778530150', latest), false);
  assert.equal(isSkillVersionInSync('skill_version_01SWtSoWt53LXFnhkcoAftAK', latest), false);
});

test('selectLatestSkillVersion handles empty or invalid inputs safely', () => {
  assert.equal(selectLatestSkillVersion([]), null);
  assert.equal(selectLatestSkillVersion(null), null);
});
