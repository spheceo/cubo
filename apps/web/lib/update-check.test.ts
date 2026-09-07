import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { coalesceLatest, isNewerRelease, parseReleaseVersion } from './update-check';

test('release tags compare as numeric triples, not strings', () => {
  assert.deepEqual(parseReleaseVersion('v0.0.11'), [0, 0, 11]);
  assert.equal(isNewerRelease('v0.0.11', '0.0.10'), true);
  assert.equal(isNewerRelease('v0.0.10', '0.0.10'), false);
  assert.equal(isNewerRelease('v0.0.9', '0.0.10'), false);
});

test('GitHub fills in when Core cached no newer release', () => {
  assert.equal(coalesceLatest(null, 'v0.0.11', '0.0.10'), 'v0.0.11');
  assert.equal(coalesceLatest(null, 'v0.0.10', '0.0.10'), null);
  assert.equal(coalesceLatest('v0.0.11', 'v0.0.12', '0.0.10'), 'v0.0.11');
});
