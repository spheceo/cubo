import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { LibraryItem } from '@cubo/core';
import { continueWatchingItems, latestHistoryForTitle, watchHistoryItems } from './library';

function item(partial: Partial<LibraryItem> & Pick<LibraryItem, 'key' | 'mediaId' | 'lastWatchedAt'>): LibraryItem {
  return {
    mediaType: 'tv',
    title: 'The Gentlemen',
    subtitle: null,
    imdbId: 'tt123',
    posterPath: null,
    backdropPath: null,
    logoPath: null,
    season: 1,
    episode: 1,
    positionSeconds: 600,
    durationSeconds: 3600,
    progress: 0.5,
    completed: false,
    watchHref: '/watch/tv/1',
    detailHref: '/tv/1',
    ...partial,
  };
}

test('watch history shows one card per title — the last episode touched, not the highest', () => {
  const olderHigher = item({
    key: 'tv:1:2:8', mediaId: 1, season: 2, episode: 8, lastWatchedAt: 10, progress: 0.5,
  });
  const lastTouched = item({
    key: 'tv:1:1:2', mediaId: 1, season: 1, episode: 2, lastWatchedAt: 50, progress: 0.1,
  });
  const movie = item({
    key: 'movie:9:-:-', mediaId: 9, mediaType: 'movie', title: 'Rush Hour 2',
    season: null, episode: null, lastWatchedAt: 40, progress: 0.1,
  });

  const history = watchHistoryItems([olderHigher, movie, lastTouched]);
  assert.deepEqual(history.map((entry) => entry.key), ['tv:1:1:2', 'movie:9:-:-']);
  assert.equal(latestHistoryForTitle([olderHigher, lastTouched], 'tv', 1)?.key, 'tv:1:1:2');
});

test('continue watching also keeps the last-touched episode of a series', () => {
  const items = continueWatchingItems([
    item({ key: 'tv:1:1:1', mediaId: 1, lastWatchedAt: 1, positionSeconds: 600, progress: 0.4 }),
    item({ key: 'tv:1:1:3', mediaId: 1, lastWatchedAt: 9, positionSeconds: 120, progress: 0.2 }),
  ]);
  assert.deepEqual(items.map((entry) => entry.key), ['tv:1:1:3']);
});
