import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { LibraryItem, MediaDetails } from '@cubo/core';
import {
  continueWatchingCandidates,
  continueWatchingEntries,
  historyForEpisode,
  investedInShow,
  latestHistoryForTitle,
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

/** Continue Watching keys with no TMDB details loaded. */
function continueWatchingItems(history: LibraryItem[]): LibraryItem[] {
  return continueWatchingEntries(continueWatchingCandidates(history), () => undefined)
    .map((entry) => entry.item);
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

test('continue watching also keeps the last-touched episode of a series', () => {
  const items = continueWatchingItems([
    item({ key: 'tv:1:1:1', mediaId: 1, lastWatchedAt: 1, positionSeconds: 600, progress: 0.4 }),
    item({ key: 'tv:1:1:3', mediaId: 1, lastWatchedAt: 9, positionSeconds: 120, progress: 0.2 }),
  ]);
  assert.deepEqual(items.map((entry) => entry.key), ['tv:1:1:3']);
});

test('continue watching ignores a brief newer episode open before grouping', () => {
  const resume = item({
    key: 'tv:8:1:1', mediaId: 8, lastWatchedAt: 10, positionSeconds: 600, progress: 0.2,
  });
  const briefOpen = item({
    key: 'tv:8:1:2', mediaId: 8, lastWatchedAt: 20, positionSeconds: 2, progress: 0.001,
  });
  assert.deepEqual(continueWatchingItems([resume, briefOpen]).map((entry) => entry.key), ['tv:8:1:1']);
});

test('continue watching includes a title after a few seconds, not half a minute', () => {
  const started = item({
    key: 'tv:2:1:11', mediaId: 2, lastWatchedAt: 20, positionSeconds: 8, progress: 0.003,
  });
  const bounce = item({
    key: 'tv:3:1:1', mediaId: 3, lastWatchedAt: 21, positionSeconds: 2, progress: 0.001,
  });
  const finished = item({
    key: 'tv:4:1:1', mediaId: 4, lastWatchedAt: 22, positionSeconds: 3570, progress: 0.991,
    durationSeconds: 3600,
  });
  const items = continueWatchingItems([started, bounce, finished]);
  assert.deepEqual(items.map((entry) => entry.key), ['tv:2:1:11']);
});

test('continue watching excludes completed rows even when the progress flag is stale', () => {
  const completed = item({
    key: 'tv:5:1:1', mediaId: 5, lastWatchedAt: 30, positionSeconds: 3570,
    progress: 0.991, completed: true,
  });
  assert.deepEqual(continueWatchingItems([completed]), []);
});

test('continue watching keeps a 90% row when more than a minute remains', () => {
  const longTail = item({
    key: 'movie:7:-:-', mediaType: 'movie', mediaId: 7, lastWatchedAt: 30,
    positionSeconds: 3420, durationSeconds: 3600, progress: 0.95, completed: true,
  });
  assert.deepEqual(continueWatchingItems([longTail]).map((entry) => entry.key), ['movie:7:-:-']);
});

test('continue watching ignores rows without a known duration', () => {
  const unknownDuration = item({
    key: 'tv:6:1:1', mediaId: 6, lastWatchedAt: 30, durationSeconds: 0,
  });
  assert.deepEqual(continueWatchingItems([unknownDuration]), []);
});

function dayOffset(days: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function daysAgoMs(days: number): number {
  return Date.now() - days * 86_400_000;
}

function details(partial: Partial<MediaDetails> & Pick<MediaDetails, 'id'>): MediaDetails {
  return {
    mediaType: 'tv',
    title: 'War',
    overview: '',
    posterPath: null,
    backdropPath: null,
    releaseDate: '2026-09-01',
    voteAverage: 7,
    imdbId: null,
    originalLanguage: 'en',
    logoPath: null,
    genres: [],
    runtime: 50,
    numberOfSeasons: 2,
    seasons: [
      { seasonNumber: 1, name: 'Season 1', episodeCount: 8, airDate: '', posterPath: null },
      { seasonNumber: 2, name: 'Season 2', episodeCount: 6, airDate: '', posterPath: null },
    ],
    nextEpisode: null,
    lastEpisode: null,
    status: 'Ended',
    ...partial,
  };
}

function finishedEpisode(mediaId: number, season: number, episode: number, lastWatchedAt: number): LibraryItem {
  return item({
    key: `tv:${mediaId}:${season}:${episode}`, mediaId, season, episode, lastWatchedAt,
    positionSeconds: 3590, durationSeconds: 3600, progress: 0.997, completed: true,
  });
}

function entriesFor(history: LibraryItem[], shows: MediaDetails[]) {
  const byId = new Map(shows.map((show) => [show.id, show]));
  return continueWatchingEntries(continueWatchingCandidates(history), (id) => byId.get(id));
}

test('a finished episode moves the card on to the next aired episode', () => {
  const [entry] = entriesFor(
    [finishedEpisode(1, 1, 3, daysAgoMs(1))],
    [details({ id: 1, lastEpisode: { seasonNumber: 1, episodeNumber: 5, name: '', airDate: dayOffset(-20) } })],
  );
  assert.equal(entry.kind, 'next');
  assert.equal(entry.label, 'S1 E4');
  assert.equal(entry.href, '/watch/tv/1?season=1&episode=4');
  assert.equal(entry.progress, 0);
  assert.equal(entry.newEpisode, false);
});

test('a season finale moves on to the next season', () => {
  const [entry] = entriesFor(
    [finishedEpisode(1, 1, 8, daysAgoMs(30))],
    [details({ id: 1, lastEpisode: { seasonNumber: 2, episodeNumber: 6, name: '', airDate: dayOffset(-60) } })],
  );
  assert.equal(entry.label, 'S2 E1');
});

test('an episode that aired after the viewer finished theirs is marked new and leads the row', () => {
  const entries = entriesFor(
    [
      item({ key: 'tv:2:1:1', mediaId: 2, lastWatchedAt: daysAgoMs(0) }),
      finishedEpisode(1, 1, 3, daysAgoMs(7)),
    ],
    [details({
      id: 1,
      status: 'Returning Series',
      lastEpisode: { seasonNumber: 1, episodeNumber: 4, name: '', airDate: dayOffset(-1) },
      nextEpisode: { seasonNumber: 1, episodeNumber: 5, name: '', airDate: dayOffset(6) },
    })],
  );
  assert.deepEqual(entries.map((entry) => [entry.item.mediaId, entry.newEpisode]), [[1, true], [2, false]]);
  assert.equal(entries[0].label, 'S1 E4');
});

test('catching up on an older season gets no new-episode pill', () => {
  const [entry] = entriesFor(
    [finishedEpisode(1, 1, 2, daysAgoMs(4))],
    [details({
      id: 1,
      status: 'Returning Series',
      lastEpisode: { seasonNumber: 2, episodeNumber: 4, name: '', airDate: dayOffset(-2) },
    })],
  );
  assert.equal(entry.label, 'S1 E3');
  assert.equal(entry.newEpisode, false);
});

test('caught up on a show that is still airing waits on the next air date', () => {
  const [entry] = entriesFor(
    [finishedEpisode(1, 1, 3, daysAgoMs(1))],
    [details({
      id: 1,
      status: 'Returning Series',
      lastEpisode: { seasonNumber: 1, episodeNumber: 3, name: '', airDate: dayOffset(-2) },
      nextEpisode: { seasonNumber: 1, episodeNumber: 4, name: '', airDate: dayOffset(0) },
    })],
  );
  assert.equal(entry.kind, 'waiting');
  assert.equal(entry.label, 'S1 E4 · Airs Today');
  assert.equal(entry.href, '/tv/1');
});

test('a returning show with nothing scheduled stays as caught up', () => {
  const [entry] = entriesFor(
    [finishedEpisode(1, 2, 6, daysAgoMs(1))],
    [details({
      id: 1,
      status: 'Returning Series',
      lastEpisode: { seasonNumber: 2, episodeNumber: 6, name: '', airDate: dayOffset(-30) },
    })],
  );
  assert.equal(entry.kind, 'waiting');
  assert.equal(entry.label, 'Caught up');
});

test('finishing the final episode of an ended show finishes it, even watched out of order', () => {
  const history = [
    finishedEpisode(1, 1, 1, daysAgoMs(3)),
    finishedEpisode(1, 2, 6, daysAgoMs(1)),
  ];
  assert.deepEqual(
    entriesFor(history, [details({
      id: 1,
      lastEpisode: { seasonNumber: 2, episodeNumber: 6, name: '', airDate: dayOffset(-300) },
    })]),
    [],
  );
});

test('a finished show waits for its details before it gets a card', () => {
  assert.deepEqual(entriesFor([finishedEpisode(1, 1, 3, daysAgoMs(1))], []), []);
});

test('a show earns the Home hero once an episode is finished or twenty minutes are in', () => {
  const peek = item({ key: 'tv:7:1:1', mediaId: 7, lastWatchedAt: 1, positionSeconds: 10, progress: 0.003 });
  assert.equal(investedInShow([peek], 7), false);

  const twoEpisodes = [
    item({ key: 'tv:7:1:1', mediaId: 7, lastWatchedAt: 1, positionSeconds: 700 }),
    item({ key: 'tv:7:1:2', mediaId: 7, episode: 2, lastWatchedAt: 2, positionSeconds: 600 }),
  ];
  assert.equal(investedInShow(twoEpisodes, 7), true);

  const finished = item({
    key: 'tv:7:1:1',
    mediaId: 7,
    lastWatchedAt: 1,
    positionSeconds: 3590,
    progress: 0.998,
  });
  assert.equal(investedInShow([finished, peek], 7), true);
  assert.equal(investedInShow([finished], 8), false);
});
