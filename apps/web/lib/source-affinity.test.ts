import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Stream } from '@cubo/core';
import {
  forgetSource,
  loadShowSource,
  loadSource,
  preferContinuity,
  preferSource,
  releaseGroup,
  rememberShowSource,
  rememberSource,
} from './source-affinity';
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

test('a remembered lower-quality source gives way to a better tier, not to seeders', () => {
  const sd = { ...english, infoHash: 'sd', quality: '480p', seeders: 1 };
  const hd = { ...english, infoHash: 'hd', quality: '1080p', seeders: 19 };
  const ranked = rankStreams([sd, hd], { transcode: true, hevc: false }, 'en');
  assert.equal(preferSource(ranked, sd)[0]?.infoHash, 'hd');
  const otherSd = { ...sd, infoHash: 'other-sd', seeders: 500 };
  const sameTier = rankStreams([otherSd, sd], { transcode: true, hevc: false }, 'en');
  assert.equal(preferSource(sameTier, sd)[0]?.infoHash, 'sd');
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

// Wayward Pines S01E06 as Torrentio listed it, after E04 and E05 played
// from the Panda season pack.
const kitsune: Stream = {
  name: 'Torrentio\n1080p',
  title: 'Wayward Pines S01E06 Choices 1080p DSNP WEB-DL DDP5 1 H 264-Kitsune\n👤 4 💾 2.21 GB ⚙️ ThePirateBay',
  filename: 'Wayward Pines S01E06 Choices 1080p DSNP WEB-DL DDP5 1 H 264-Kitsune.mkv',
  infoHash: 'kitsune', fileIdx: 1, quality: '1080p', sizeBytes: 2_372_969_431, seeders: 4, trackers: [],
};
const pandaPack: Stream = {
  name: 'Torrentio\n1080p',
  title: 'Wayward Pines (2015) Season 1 S01 (1080p BluRay x265 HEVC 10bit AAC 5.1 Panda) [QxR]\nWayward Pines (2015) - S01E06 - Choices (1080p BluRay x265 Panda).mkv\n👤 54 💾 948.79 MB ⚙️ 1337x',
  filename: 'Wayward Pines (2015) - S01E06 - Choices (1080p BluRay x265 Panda).mkv',
  infoHash: 'panda', fileIdx: 7, quality: '1080p', sizeBytes: 994_878_423, seeders: 54, trackers: [],
};
const kontrast: Stream = {
  name: 'Torrentio\n1080p',
  title: 'Wayward.Pines.S01.1080p.BluRay.x265-KONTRAST\nWayward.Pines.S01E06.1080p.BluRay.x265-KONTRAST.mp4\n👤 24 💾 675.78 MB ⚙️ TorrentGalaxy',
  filename: 'Wayward.Pines.S01E06.1080p.BluRay.x265-KONTRAST.mp4',
  infoHash: 'kontrast', fileIdx: 16, quality: '1080p', sizeBytes: 708_606_689, seeders: 24, trackers: [],
};
const sixth = { season: 1, episode: 6 };

test('a near-dead single episode no longer beats healthy packs of the same tier', () => {
  const ranked = rankStreams([kitsune, pandaPack, kontrast], { transcode: true, hevc: true }, 'en', sixth);
  assert.equal(ranked.length, 3);
  assert.equal(ranked.at(-1)?.infoHash, 'kitsune');
});

test('the next episode plays from the season pack the last one played from', () => {
  const ranked = rankStreams([kitsune, pandaPack, kontrast], { transcode: true, hevc: true }, 'en', sixth);
  const previous = { ...pandaPack, fileIdx: 6 };
  assert.equal(preferContinuity(ranked, previous)[0]?.infoHash, 'panda');
  assert.deepEqual(preferContinuity(ranked, null), ranked);
});

test('continuity follows the release group, but never onto a near-dead swarm or a worse tier', () => {
  const previousKontrast = { ...kontrast, infoHash: 'kontrast-e05', fileIdx: 15 };
  const ranked = rankStreams([pandaPack, kontrast], { transcode: true, hevc: true }, 'en', sixth);
  assert.equal(preferContinuity(ranked, previousKontrast)[0]?.infoHash, 'kontrast');
  const previousKitsune = { ...kitsune, infoHash: 'kitsune-e05' };
  const withKitsune = rankStreams([kitsune, pandaPack], { transcode: true, hevc: true }, 'en', sixth);
  assert.equal(preferContinuity(withKitsune, previousKitsune)[0]?.infoHash, 'panda');
  const lowerTier = { ...kontrast, quality: '720p' };
  assert.equal(preferContinuity([pandaPack, lowerTier], previousKontrast)[0]?.infoHash, 'panda');
});

test('release groups come from scene-style names only', () => {
  assert.equal(releaseGroup(kitsune), 'kitsune');
  assert.equal(releaseGroup(kontrast), 'kontrast');
  assert.equal(releaseGroup({ ...kitsune, filename: null, title: 'The Traitors US S05E05 1080p AMZN WEB-DL DDP5 1 H 264-RAWR[EZTVx.to].mkv' }), 'rawr');
  assert.equal(releaseGroup({ ...kitsune, filename: null, title: 'Show S01E01 1080p WEB-DL' }), null);
  assert.equal(releaseGroup(pandaPack), null);
});

test('the show source survives storage like the episode source', () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try {
    assert.equal(loadShowSource(53425), null);
    rememberShowSource(53425, pandaPack);
    assert.equal(loadShowSource(53425)?.infoHash, 'panda');
    assert.equal(loadShowSource(1), null);
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
