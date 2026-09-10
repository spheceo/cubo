import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isAdvancingPlayback } from './player-readiness';

const playing = { currentTime: 116, paused: false, seeking: false, readyState: 3 };

test('advancing ready playback clears a stale waiting indication', () => {
  assert.equal(isAdvancingPlayback(115, playing), true);
  assert.equal(isAdvancingPlayback(115, { ...playing, readyState: 4 }), true);
});

test('seeks, paused updates and a genuinely empty buffer do not claim recovery', () => {
  assert.equal(isAdvancingPlayback(115, { ...playing, seeking: true }), false);
  assert.equal(isAdvancingPlayback(115, { ...playing, paused: true }), false);
  assert.equal(isAdvancingPlayback(115, { ...playing, readyState: 2 }), false);
  assert.equal(isAdvancingPlayback(116, playing), false);
  assert.equal(isAdvancingPlayback(200, playing), false);
  assert.equal(isAdvancingPlayback(null, playing), false);
});
