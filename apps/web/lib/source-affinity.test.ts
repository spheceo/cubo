import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Stream } from '@cubo/core';
import { forgetSource, loadSource, preferSource, rememberSource } from './source-affinity';
import { isAutomaticSource, rankPreviewStreams, rankStreams } from './stream-select';

const english: Stream = {
  name: '1080p', title: 'Movie English WEB-DL', filename: 'movie.mp4',
  infoHash: 'english', fileIdx: 1, quality: '1080p', sizeBytes: 2_000_000_000,
  seeders: 60, trackers: [],
};

test('successful torrent and file survive a revisit despite seeder changes', () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try {
    rememberSource('movie:42', english);
    const saved = loadSource('movie:42');
    assert.equal(saved?.fileIdx, 1);
    const changed = { ...english, infoHash: 'different-rip', seeders: 1000 };
    const ranked = rankStreams([changed, english], { transcode: true, hevc: false }, 'en');
    assert.equal(preferSource(ranked, saved)[0]?.infoHash, 'english');
    assert.equal(loadSource('tv:42:1:1'), null);
    forgetSource('movie:42', 'unrelated-failure');
    assert.equal(loadSource('movie:42')?.infoHash, 'english');
    forgetSource('movie:42', 'english');
    assert.equal(loadSource('movie:42'), null);
    const otherFile = { ...english, fileIdx: 2 };
    assert.equal(preferSource([otherFile], saved)[0]?.fileIdx, 2);
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('automatic playback excludes explicit foreign audio and cinema captures', () => {
  assert.equal(isAutomaticSource(english, 'en'), true);
  assert.equal(isAutomaticSource({ ...english, title: 'Movie Spanish 🇪🇸' }, 'en'), false);
  assert.equal(isAutomaticSource({ ...english, title: 'Movie English CAM' }, 'en'), false);
  assert.equal(isAutomaticSource({ ...english, title: 'Movie WEB-DL' }, 'en'), true);
});

test('healthy previews prefer 1080p and never substitute a known dub', () => {
  const lower = { ...english, infoHash: '720', quality: '720p', seeders: 900 };
  const dub = { ...english, infoHash: 'dub', title: 'Spanish 🇪🇸', seeders: 1000 };
  const ranked = rankPreviewStreams([lower, dub, english], 'en');
  assert.equal(ranked[0]?.infoHash, 'english');
  assert.equal(ranked.some((stream) => stream.infoHash === 'dub'), false);
});
