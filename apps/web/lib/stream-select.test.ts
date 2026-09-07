import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Stream } from '@cubo/core';
import { rankStreams, seasonPackRank } from './stream-select';

const episode = { season: 2, episode: 1 };
const single: Stream = {
  name: 'Torrentio 1080p', title: 'The.Gentlemen.S02E01.1080p',
  filename: 'The.Gentlemen.S02E01.mkv', infoHash: 'single', fileIdx: 0,
  quality: '1080p', sizeBytes: 800_000_000, seeders: 20, trackers: [],
};
const pack: Stream = {
  ...single, infoHash: 'pack', title: 'The.Gentlemen.S02.COMPLETE.1080p',
  sizeBytes: 3_900_000_000, seeders: 100,
};

test('a selected episode filename does not hide explicit season-pack metadata', () => {
  assert.equal(seasonPackRank(pack, episode), 2);
  assert.equal(seasonPackRank(single, episode), 0);
  assert.equal(seasonPackRank({ ...pack, title: 'The Gentlemen Season 2' }, episode), 2);
  assert.equal(seasonPackRank({ ...pack, title: 'The.Gentlemen.S02.1080p' }, episode), 2);
  assert.equal(seasonPackRank({ ...single, title: 'The.Gentlemen.2x01' }, episode), 0);
});

test('single episodes beat larger healthy packs within the same playback tier', () => {
  assert.deepEqual(rankStreams([pack, single], { transcode: true, hevc: false }, null, episode)
    .map((stream) => stream.infoHash), ['single', 'pack']);
});

test('direct-play priority is preserved ahead of remux within the quality tier', () => {
  const directPack = { ...pack, filename: 'The.Gentlemen.S02E01.mp4' };
  assert.equal(rankStreams([single, directPack], { transcode: true, hevc: false }, null, episode)[0], directPack);
});

test('movie ranking has no episode pack preference', () => {
  assert.equal(seasonPackRank(pack), 0);
});
