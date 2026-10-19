import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { MediaSummary, WatchProvider } from '@cubo/core';
import {
  catalogRegions,
  chosenServices,
  findService,
  guessRegion,
  mergeCatalog,
  rankServices,
} from './streaming-services';

const service = (
  id: number,
  priorities: Record<string, number>,
  priority = 10,
  ids = [id],
): WatchProvider => ({ id, ids, name: `S${id}`, logoPath: null, priorities, priority });
const ids = (list: WatchProvider[]) => list.map((entry) => entry.id);

test('the time zone wins over a US-English browser', () => {
  assert.equal(guessRegion('Africa/Johannesburg', ['en-US']), 'ZA');
});

test('without a known zone, the first language naming a region decides', () => {
  assert.equal(guessRegion('Etc/UTC', ['en', 'pt-BR', 'de-DE']), 'BR');
  assert.equal(guessRegion(undefined, ['zh-Hant-TW']), 'TW');
});

test('defaults to the US when nothing says', () => {
  assert.equal(guessRegion(undefined, ['en']), 'US');
});

const netflix = service(8, { ZA: 0, US: 0 }, 0);
const apple = service(350, { ZA: 3, US: 2 }, 3);
const disney = service(337, { US: 1 }, 3);
const prime = service(9, { DE: 1, US: 4 }, 1, [9, 119]);
const local = service(55, { ZA: 1 }, 40);
const all = [netflix, apple, disney, prime, local];

test('services in the viewer’s country list first, by prominence there', () => {
  assert.deepEqual(ids(rankServices(all, 'ZA')), [8, 55, 350, 9, 337]);
});

test('the big four are the default, wherever the viewer is', () => {
  assert.deepEqual(ids(chosenServices(all)), [8, 350, 337, 9]);
});

test('a service is found under any of its TMDB ids', () => {
  assert.equal(findService(all, 119), prime);
  assert.deepEqual(ids(chosenServices(all, [119, 999, 8])), [9, 8]);
});

test('catalogues read the viewer’s country and the big ones the service is in', () => {
  assert.deepEqual(catalogRegions(netflix, 'ZA'), ['ZA', 'US']);
  assert.deepEqual(catalogRegions(disney, 'ZA'), ['US']);
});

test('a service in none of them reads its own leading countries', () => {
  const regional = service(1, { BR: 3, PT: 1, AO: 2 });
  assert.deepEqual(catalogRegions(regional, 'ZA'), ['PT', 'AO']);
});

const title = (id: number, extra: Partial<MediaSummary>): MediaSummary => ({
  id,
  mediaType: 'tv',
  title: `T${id}`,
  overview: '',
  posterPath: null,
  backdropPath: null,
  releaseDate: '2026-01-01',
  voteAverage: 5,
  ...extra,
});

test('merged pages keep each title once, in the row’s order', () => {
  const za = [title(1, { popularity: 50 }), title(2, { popularity: 10 })];
  const us = [title(3, { popularity: 90 }), title(1, { popularity: 50 })];
  assert.deepEqual(
    mergeCatalog([za, us], 'popular').map((item) => item.id),
    [3, 1, 2],
  );
  const dated = [[title(4, { releaseDate: '2026-03-01' })], [title(5, { releaseDate: '2026-09-01' })]];
  assert.deepEqual(mergeCatalog(dated, 'newest').map((item) => item.id), [5, 4]);
});
