import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { playableResume, resumeSeconds, type StoredPlayhead } from './playhead';

function head(
  positionSeconds: number,
  durationSeconds: number,
  updatedAt: number,
): StoredPlayhead {
  return { positionSeconds, durationSeconds, updatedAt };
}

test('resume keeps a late playhead instead of treating 90% as the start', () => {
  assert.equal(playableResume(3504, 3563), 3504);
  assert.equal(playableResume(4, 3563), 0);
  assert.equal(playableResume(3562, 3563), 0);
  assert.equal(playableResume(0, 3563), 0);
});

test('resume prefers the newer snapshot so a seek-back wins over Core', () => {
  const local = head(600, 3600, 200);
  const remote = head(3000, 3600, 100);
  assert.equal(resumeSeconds(local, remote), 600);
  assert.equal(resumeSeconds(null, remote), 3000);
  assert.equal(resumeSeconds(local, null), 600);
  assert.equal(resumeSeconds(null, null), 0);
});
