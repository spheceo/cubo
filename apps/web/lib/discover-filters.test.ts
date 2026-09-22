import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { MediaSummary } from '@cubo/core';
import {
  DEFAULT_FILTERS,
  filtersToParams,
  filtersToQuery,
  matchesFilters,
  parseDiscoverParams,
  PRESETS,
  sameFilters,
} from './discover-filters';

function summary(patch: Partial<MediaSummary>): MediaSummary {
  return {
    id: 1,
    mediaType: 'movie',
    title: 'x',
    overview: '',
    posterPath: '/p.jpg',
    backdropPath: null,
    releaseDate: '2015-01-01',
    voteAverage: 7,
    ...patch,
  };
}

function params(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

describe('parseDiscoverParams', () => {
  test('empty params produce the defaults', () => {
    assert.deepEqual(parseDiscoverParams(params('')), DEFAULT_FILTERS);
  });

  test('reads every supported key', () => {
    assert.deepEqual(
      parseDiscoverParams(
        params('type=tv&sort=rating&genres=18,35&min=7&era=2010&vcn=25&vcm=400'),
      ),
      {
        mediaType: 'tv',
        sortBy: 'rating',
        genreIds: [18, 35],
        minVote: 7,
        era: '2010',
        minVoteCount: 25,
        maxVoteCount: 400,
      },
    );
  });

  test('rejects unknown values instead of passing them upstream', () => {
    const filters = parseDiscoverParams(
      params('type=music&sort=chaos&genres=abc,-3,28&min=9&era=jurassic'),
    );
    assert.equal(filters.mediaType, 'movie');
    assert.equal(filters.sortBy, 'popular');
    assert.deepEqual(filters.genreIds, [28]);
    assert.equal(filters.minVote, null);
    assert.equal(filters.era, 'any');
  });
});

describe('filtersToParams', () => {
  test('serializes only non-default values', () => {
    assert.equal(filtersToParams(DEFAULT_FILTERS).toString(), '');
    assert.equal(
      filtersToParams({ ...DEFAULT_FILTERS, mediaType: 'tv', minVote: 7 }).toString(),
      'type=tv&min=7',
    );
  });

  test('round-trips through the parser', () => {
    const filters = {
      ...DEFAULT_FILTERS,
      sortBy: 'rating' as const,
      genreIds: [16, 10751],
      era: '1990',
      minVoteCount: 50,
    };
    assert.deepEqual(parseDiscoverParams(filtersToParams(filters)), filters);
  });
});

describe('filtersToQuery', () => {
  test('maps a decade to a release-year range', () => {
    const query = filtersToQuery({ ...DEFAULT_FILTERS, era: '2010' });
    assert.equal(query.yearFrom, 2010);
    assert.equal(query.yearTo, 2019);
  });

  test('maps classics to everything before 1980', () => {
    const query = filtersToQuery({ ...DEFAULT_FILTERS, era: 'classic' });
    assert.equal(query.yearFrom, undefined);
    assert.equal(query.yearTo, 1979);
  });

  test('omits empty filters entirely', () => {
    const query = filtersToQuery(DEFAULT_FILTERS);
    assert.equal(query.mediaType, 'movie');
    assert.equal(query.sortBy, 'popular');
    assert.equal(query.genreIds, undefined);
    assert.equal(query.minVote, undefined);
    assert.equal(query.yearFrom, undefined);
    assert.equal(query.yearTo, undefined);
    assert.equal(query.minVoteCount, undefined);
    assert.equal(query.maxVoteCount, undefined);
  });
});

describe('PRESETS', () => {
  test('presets keep the current media type', () => {
    const tv = { ...DEFAULT_FILTERS, mediaType: 'tv' as const };
    for (const preset of PRESETS) {
      assert.equal(preset.apply(tv).mediaType, 'tv');
    }
  });

  test('sameFilters ignores genre order', () => {
    const a = { ...DEFAULT_FILTERS, genreIds: [28, 35] };
    const b = { ...DEFAULT_FILTERS, genreIds: [35, 28] };
    assert.equal(sameFilters(a, b), true);
  });
});

describe('matchesFilters', () => {
  test('passes an untouched filter set', () => {
    assert.equal(matchesFilters(summary({}), DEFAULT_FILTERS), true);
  });

  test('requires an overlapping genre when genres are set', () => {
    const filters = { ...DEFAULT_FILTERS, genreIds: [35] };
    assert.equal(matchesFilters(summary({ genreIds: [28] }), filters), false);
    assert.equal(matchesFilters(summary({ genreIds: [28, 35] }), filters), true);
    // Providers without genre ids never satisfy a genre filter.
    assert.equal(matchesFilters(summary({}), filters), false);
  });

  test('enforces rating floor and era window', () => {
    const filters = { ...DEFAULT_FILTERS, minVote: 8, era: '2010' };
    assert.equal(matchesFilters(summary({ voteAverage: 8.4 }), filters), true);
    assert.equal(matchesFilters(summary({ voteAverage: 7.9 }), filters), false);
    assert.equal(matchesFilters(summary({ releaseDate: '2005-06-01' }), filters), false);
    assert.equal(matchesFilters(summary({ releaseDate: '' }), filters), false);
  });

  test('rejects the wrong media type', () => {
    assert.equal(matchesFilters(summary({ mediaType: 'tv' }), DEFAULT_FILTERS), false);
  });
});
