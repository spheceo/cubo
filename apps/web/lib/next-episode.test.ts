import test from 'node:test';
import assert from 'node:assert/strict';
import type { Episode, SeasonSummary } from '@cubo/core';
import { resolveNextEpisode } from './next-episode';

function episode(seasonNumber: number, episodeNumber: number, airDate = '2020-01-01'): Episode {
  return {
    id: seasonNumber * 1000 + episodeNumber,
    seasonNumber,
    episodeNumber,
    name: `S${seasonNumber}E${episodeNumber}`,
    overview: '',
    stillPath: null,
    airDate,
    runtime: 45,
    voteAverage: 7,
  };
}

function season(seasonNumber: number, episodeCount: number, airDate = '2020-01-01'): SeasonSummary {
  return {
    seasonNumber,
    name: `Season ${seasonNumber}`,
    episodeCount,
    airDate,
    posterPath: null,
  };
}

test('next episode in the same season wins', () => {
  const episodes = [episode(2, 5), episode(2, 6)];
  assert.deepEqual(resolveNextEpisode([season(2, 6)], episodes, 2, 5), {
    season: 2,
    episode: 6,
  });
});

test('crosses into the next season on a finale', () => {
  const seasons = [season(1, 8), season(2, 8)];
  const episodes = [episode(1, 8)];
  assert.deepEqual(resolveNextEpisode(seasons, episodes, 1, 8), {
    season: 2,
    episode: 1,
  });
});

test('skips a gap season and never walks backwards', () => {
  const seasons = [season(1, 8), season(3, 8), season(2, 8)];
  const episodes = [episode(1, 8)];
  assert.deepEqual(resolveNextEpisode(seasons, episodes, 1, 8), {
    season: 2,
    episode: 1,
  });
});

test('returns null on a series finale', () => {
  const seasons = [season(1, 8)];
  const episodes = [episode(1, 8)];
  assert.equal(resolveNextEpisode(seasons, episodes, 1, 8), null);
});

test('an unaired next episode falls through to an aired next season', () => {
  const seasons = [season(1, 10), season(2, 8)];
  // E6 exists in TMDB but airs next month — currently on E5.
  const episodes = [episode(1, 5), episode(1, 6, '2999-01-01')];
  assert.deepEqual(resolveNextEpisode(seasons, episodes, 1, 5), {
    season: 2,
    episode: 1,
  });
});

test('an unaired next season yields nothing', () => {
  const seasons = [season(1, 8), season(2, 8, '2999-01-01')];
  const episodes = [episode(1, 8)];
  assert.equal(resolveNextEpisode(seasons, episodes, 1, 8), null);
});

test('empty or missing season data yields nothing', () => {
  assert.equal(resolveNextEpisode([season(1, 8)], undefined, 1, 8), null);
  assert.equal(resolveNextEpisode(undefined, [episode(1, 8)], 1, 8), null);
});

test('a season with zero episodes is skipped', () => {
  const seasons = [season(1, 8), season(2, 0), season(3, 8)];
  const episodes = [episode(1, 8)];
  assert.deepEqual(resolveNextEpisode(seasons, episodes, 1, 8), {
    season: 3,
    episode: 1,
  });
});
