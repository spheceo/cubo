import test from 'node:test';
import assert from 'node:assert/strict';
import type { Episode, LibraryItem, MediaDetails } from '@cubo/core';
import { dayKey, monthGrid, scheduleEntries, watchingShowIds } from './schedule';
import { formatAirsLabel } from './air-date';

function daysFromNow(days: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return dayKey(date);
}

function show(id: number, nextAirDate: string | null): MediaDetails {
  return {
    id,
    mediaType: 'tv',
    title: `Show ${id}`,
    overview: '',
    posterPath: null,
    backdropPath: null,
    releaseDate: '2020-01-01',
    voteAverage: 7,
    imdbId: null,
    originalLanguage: 'en',
    logoPath: null,
    genres: [],
    runtime: 45,
    numberOfSeasons: 1,
    seasons: [],
    nextEpisode: nextAirDate
      ? { seasonNumber: 1, episodeNumber: 3, name: 'Three', airDate: nextAirDate }
      : null,
  };
}

function episode(episodeNumber: number, airDate: string): Episode {
  return {
    id: episodeNumber,
    seasonNumber: 1,
    episodeNumber,
    name: `E${episodeNumber}`,
    overview: '',
    stillPath: null,
    airDate,
    runtime: 45,
    voteAverage: 7,
  };
}

test('watching shows are unique TV titles, most recent first', () => {
  const item = (mediaId: number, mediaType: 'tv' | 'movie', lastWatchedAt: number) =>
    ({ mediaId, mediaType, lastWatchedAt }) as LibraryItem;
  assert.deepEqual(
    watchingShowIds([item(1, 'tv', 10), item(2, 'movie', 50), item(3, 'tv', 30), item(1, 'tv', 40)]),
    [1, 3],
  );
});

test('schedule keeps only upcoming episodes of shows with a next episode', () => {
  const entries = scheduleEntries(
    [
      {
        details: show(1, daysFromNow(2)),
        episodes: [episode(2, daysFromNow(-5)), episode(3, daysFromNow(2)), episode(4, daysFromNow(9))],
      },
      { details: show(2, null), episodes: [episode(1, daysFromNow(1))] },
      { details: show(3, daysFromNow(0)), episodes: undefined },
    ],
    new Date(),
  );
  assert.deepEqual(
    entries.map((entry) => `${entry.showId}:E${entry.episode}`),
    ['3:E3', '1:E3', '1:E4'],
  );
});

test('month grid covers whole Monday-first weeks', () => {
  const days = monthGrid(new Date(2026, 9, 15));
  assert.equal(days.length % 7, 0);
  assert.equal(days[0]!.getDay(), 1);
  assert.equal(dayKey(days[0]!), '2026-09-28');
  assert.ok(days.some((day) => dayKey(day) === '2026-10-31'));
});

test('air labels past tomorrow carry a date so a weekday is never ambiguous', () => {
  assert.equal(formatAirsLabel(daysFromNow(0)), 'Airs Today');
  assert.equal(formatAirsLabel(daysFromNow(1)), 'Airs Tomorrow');
  assert.match(formatAirsLabel(daysFromNow(6)) ?? '', /^Airs \w+, \w+ \d+/);
  assert.equal(formatAirsLabel(daysFromNow(-1)), null);
});
