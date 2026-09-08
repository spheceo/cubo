import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { LibraryItem } from '@cubo/core';
import {
  continueWatchingItems,
  historyForEpisode,
  latestHistoryForTitle,
  nextEpisodeTarget,
  playButtonLabel,
  watchHistoryItems,
} from './library';

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

test('episode list progress is the row for that season and episode', () => {
  const e1 = item({ key: 'tv:1:1:1', mediaId: 1, season: 1, episode: 1, lastWatchedAt: 1, progress: 0.4 });
  const e2 = item({ key: 'tv:1:1:2', mediaId: 1, season: 1, episode: 2, lastWatchedAt: 9, progress: 0.7 });
  assert.equal(historyForEpisode([e1, e2], 1, 1, 2)?.progress, 0.7);
  assert.equal(historyForEpisode([e1, e2], 1, 1, 3), undefined);
});

test('title play button names the last-touched episode', () => {
  assert.equal(playButtonLabel('movie'), 'Watch Now');
  assert.equal(playButtonLabel('tv', null, 2), 'Watch S2 E1');
  assert.equal(playButtonLabel('tv', { season: 2, episode: 1 }), 'Continue S2 E1');
});

test('next episode walks the current season then the next season', () => {
  const seasons = [
    { seasonNumber: 1, episodeCount: 8 },
    { seasonNumber: 2, episodeCount: 8 },
  ];
  assert.deepEqual(nextEpisodeTarget(seasons, 1, 7), { season: 1, episode: 8 });
  assert.deepEqual(nextEpisodeTarget(seasons, 1, 8), { season: 2, episode: 1 });
  assert.equal(nextEpisodeTarget(seasons, 2, 8), null);
});

test('continue watching also keeps the last-touched episode of a series', () => {
  const items = continueWatchingItems([
    item({ key: 'tv:1:1:1', mediaId: 1, lastWatchedAt: 1, positionSeconds: 600, progress: 0.4 }),
    item({ key: 'tv:1:1:3', mediaId: 1, lastWatchedAt: 9, positionSeconds: 120, progress: 0.2 }),
  ]);
  assert.deepEqual(items.map((entry) => entry.key), ['tv:1:1:3']);
});
