import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { MediaSummary } from '@cubo/core';
import { FEATURED_HOLD_MS, pickFeatured, resolveFeatured } from './featured-selection';

function title(id: number, mediaType: 'movie' | 'tv' = 'movie'): MediaSummary {
  return { id, mediaType, title: String(id), overview: '', posterPath: '/poster.jpg',
    backdropPath: '/backdrop.jpg', releaseDate: '2020-01-01', voteAverage: 8 };
}

test('rotation exhausts unseen titles before repeating, then chooses the oldest feature', () => {
  const candidates = [title(1), title(2), title(3)];
  assert.equal(pickFeatured(candidates, ['movie:1'], 0)?.id, 2);
  assert.equal(pickFeatured(candidates, ['movie:1', 'movie:2'], 0)?.id, 3);
  assert.equal(pickFeatured(candidates, ['movie:2', 'movie:3', 'movie:1'], 0)?.id, 2);
});

test('Home can feature shows and identical numeric movie/TV IDs remain distinct', () => {
  const candidates = [title(1), title(1, 'tv')];
  assert.equal(pickFeatured(candidates, ['movie:1'], 0)?.mediaType, 'tv');
});

test('duplicate rows do not weight selection and unreleased/artwork-free titles are excluded', () => {
  const candidates = [title(1), title(1), title(2),
    { ...title(3), releaseDate: '2030-01-01' }, { ...title(4), backdropPath: null }];
  assert.equal(pickFeatured(candidates, [], 0.6, '2026-09-10')?.id, 2);
  assert.equal(pickFeatured([], [], 0), null);
  assert.equal(pickFeatured([{ ...title(4), backdropPath: null }], [], 0), null);
});

test('titles older than a decade are not featured', () => {
  const recent = { ...title(1), releaseDate: '2024-06-01' };
  const vintage = { ...title(2), releaseDate: '2007-08-05' };
  assert.equal(pickFeatured([vintage, recent], [], 0, '2026-09-10')?.id, 1);
  assert.equal(pickFeatured([vintage], [], 0, '2026-09-10'), null);
  assert.equal(
    pickFeatured([{ ...title(3), releaseDate: '2016-01-01' }], [], 0, '2026-09-10')?.id,
    3,
  );
  assert.equal(
    pickFeatured([{ ...title(4), releaseDate: '2015-12-31' }], [], 0, '2026-09-10'),
    null,
  );
});

test('poorly rated titles only feature when nothing better is eligible', () => {
  const acclaimed = title(1);
  const panned = { ...title(2), voteAverage: 4.5 };
  const unrated = { ...title(3), voteAverage: 0 };
  assert.equal(pickFeatured([panned, acclaimed, unrated], [], 0)?.id, 1);
  assert.equal(pickFeatured([panned, acclaimed, unrated], [], 0.99)?.id, 1);
  assert.equal(pickFeatured([panned, unrated], [], 0)?.id, 2);
});

test('a featured title hangs across loads until the hold expires', () => {
  const candidates = [title(1), title(2), title(3)];
  const now = Date.parse('2026-09-10T12:00:00Z');
  const first = resolveFeatured(candidates, [], null, now, 0, '2026-09-10');
  assert.equal(first.item?.id, 1);
  const refresh = resolveFeatured(
    candidates,
    first.history,
    first.hold,
    now + 60_000,
    0.9,
    '2026-09-10',
  );
  assert.equal(refresh.item?.id, 1);
  assert.deepEqual(refresh.history, first.history);
  const later = resolveFeatured(
    candidates,
    first.history,
    first.hold,
    now + FEATURED_HOLD_MS,
    0,
    '2026-09-10',
  );
  assert.equal(later.item?.id, 2);
});

test('an expired or ineligible hold rotates instead of sticking', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const vintage = { ...title(1), releaseDate: '2007-08-05' };
  const recent = title(2);
  const stuck = resolveFeatured(
    [vintage, recent],
    [],
    { key: 'movie:1', until: now + FEATURED_HOLD_MS },
    now,
    0,
    '2026-09-10',
  );
  assert.equal(stuck.item?.id, 2);
});
