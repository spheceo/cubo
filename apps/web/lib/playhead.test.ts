import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { loadPlayhead, savePlayhead, playableResume, resumeForSource, resumeSeconds, type StoredPlayhead } from './playhead';

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

test('a short leftover does not seek into a different torrent', () => {
  assert.equal(resumeForSource(72, 'pack-hash', 'yts-hash'), 0);
  assert.equal(resumeForSource(72, 'yts-hash', 'yts-hash'), 72);
  assert.equal(resumeForSource(72, undefined, 'yts-hash'), 72);
  assert.equal(resumeForSource(600, 'pack-hash', 'yts-hash'), 600);
});


test('a backward seek is durable locally before Core acknowledges it', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } } });
  try {
    const oldTime = savePlayhead('movie:1', 1800, 3600, 'same-rip');
    const seekTime = savePlayhead('movie:1', 120, 3600, 'same-rip');
    assert.ok(seekTime > oldTime);
    assert.equal(resumeSeconds(loadPlayhead('movie:1'), head(1800, 3600, oldTime)), 120);
    assert.equal(loadPlayhead('movie:1')?.infoHash, 'same-rip');
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
