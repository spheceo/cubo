import type { DiscoverQuery, DiscoverSort, MediaSummary, MediaType } from '@cubo/core';

/** URL-driven filter state for the Discover page. Kept flat and explicit so
 *  every combination is shareable and the presets are just named bundles. */
export interface DiscoverFilters {
  mediaType: MediaType;
  sortBy: DiscoverSort;
  genreIds: number[];
  minVote: number | null;
  /** 'any', a decade start year ('2020'), or 'classic' (pre-1980). */
  era: string;
  minVoteCount: number | null;
  maxVoteCount: number | null;
}

export const DEFAULT_FILTERS: DiscoverFilters = {
  mediaType: 'movie',
  sortBy: 'popular',
  genreIds: [],
  minVote: null,
  era: 'any',
  minVoteCount: null,
  maxVoteCount: null,
};

export const ERAS = [
  { value: 'any', label: 'Any era' },
  { value: '2020', label: '2020s' },
  { value: '2010', label: '2010s' },
  { value: '2000', label: '2000s' },
  { value: '1990', label: "'90s" },
  { value: '1980', label: "'80s" },
  { value: 'classic', label: 'Classics' },
] as const;

export const MIN_VOTES = [
  { value: 0, label: 'Any rating' },
  { value: 6, label: '6+' },
  { value: 7, label: '7+' },
  { value: 8, label: '8+' },
] as const;

export const SORTS: { value: DiscoverSort; label: string }[] = [
  { value: 'popular', label: 'Most popular' },
  { value: 'rating', label: 'Highest rated' },
  { value: 'newest', label: 'Newest' },
];

/** Named filter bundles — the zero-effort path into discovery. */
export const PRESETS: {
  id: string;
  label: string;
  apply: (filters: DiscoverFilters) => DiscoverFilters;
}[] = [
  {
    id: 'trending',
    label: 'Trending',
    apply: (f) => ({ ...DEFAULT_FILTERS, mediaType: f.mediaType }),
  },
  {
    id: 'new',
    label: 'New releases',
    apply: (f) => ({ ...DEFAULT_FILTERS, mediaType: f.mediaType, sortBy: 'newest' }),
  },
  {
    id: 'rated',
    label: 'Top rated',
    apply: (f) => ({ ...DEFAULT_FILTERS, mediaType: f.mediaType, sortBy: 'rating' }),
  },
  {
    id: 'classics',
    label: 'Classics',
    apply: (f) => ({
      ...DEFAULT_FILTERS,
      mediaType: f.mediaType,
      sortBy: 'rating',
      era: 'classic',
    }),
  },
];

export function parseDiscoverParams(params: URLSearchParams): DiscoverFilters {
  const mediaType = params.get('type') === 'tv' ? 'tv' : 'movie';
  const sortParam = params.get('sort');
  const sortBy: DiscoverSort =
    sortParam === 'rating' || sortParam === 'newest' ? sortParam : 'popular';
  const genreIds = (params.get('genres') ?? '')
    .split(',')
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  const min = Number(params.get('min'));
  const minVote = [6, 7, 8].includes(min) ? min : null;
  const eraParam = params.get('era') ?? 'any';
  const era = ERAS.some((entry) => entry.value === eraParam) ? eraParam : 'any';
  const vcn = Number(params.get('vcn'));
  const vcm = Number(params.get('vcm'));
  return {
    mediaType,
    sortBy,
    genreIds,
    minVote,
    era,
    minVoteCount: Number.isSafeInteger(vcn) && vcn > 0 ? vcn : null,
    maxVoteCount: Number.isSafeInteger(vcm) && vcm > 0 ? vcm : null,
  };
}

/** Serializes only non-default values so shared links stay short. */
export function filtersToParams(filters: DiscoverFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.mediaType !== DEFAULT_FILTERS.mediaType) params.set('type', filters.mediaType);
  if (filters.sortBy !== DEFAULT_FILTERS.sortBy) params.set('sort', filters.sortBy);
  if (filters.genreIds.length) params.set('genres', filters.genreIds.join(','));
  if (filters.minVote != null) params.set('min', String(filters.minVote));
  if (filters.era !== 'any') params.set('era', filters.era);
  if (filters.minVoteCount != null) params.set('vcn', String(filters.minVoteCount));
  if (filters.maxVoteCount != null) params.set('vcm', String(filters.maxVoteCount));
  return params;
}

export function filtersToQuery(filters: DiscoverFilters): Omit<DiscoverQuery, 'page'> {
  const decade = filters.era !== 'any' && filters.era !== 'classic' ? Number(filters.era) : null;
  return {
    mediaType: filters.mediaType,
    sortBy: filters.sortBy,
    genreIds: filters.genreIds.length ? filters.genreIds : undefined,
    minVote: filters.minVote ?? undefined,
    minVoteCount: filters.minVoteCount ?? undefined,
    maxVoteCount: filters.maxVoteCount ?? undefined,
    yearFrom: decade ?? undefined,
    yearTo: filters.era === 'classic' ? 1979 : decade != null ? decade + 9 : undefined,
  };
}

/** Client-side filter check for pools that didn't come from the discover
 *  endpoint (e.g. related-title picks). Vote counts aren't on summaries, so
 *  the minVoteCount/maxVoteCount bounds are approximated away here. */
export function matchesFilters(item: MediaSummary, filters: DiscoverFilters): boolean {
  if (item.mediaType !== filters.mediaType) return false;
  if (
    filters.genreIds.length > 0 &&
    !(item.genreIds ?? []).some((id) => filters.genreIds.includes(id))
  ) {
    return false;
  }
  if (filters.minVote != null && item.voteAverage < filters.minVote) return false;
  const { yearFrom, yearTo } = filtersToQuery(filters);
  const year = Number(item.releaseDate.slice(0, 4));
  if (yearFrom != null && (!year || year < yearFrom)) return false;
  if (yearTo != null && (!year || year > yearTo)) return false;
  return true;
}

export function sameFilters(a: DiscoverFilters, b: DiscoverFilters): boolean {
  return (
    a.mediaType === b.mediaType &&
    a.sortBy === b.sortBy &&
    a.minVote === b.minVote &&
    a.era === b.era &&
    a.minVoteCount === b.minVoteCount &&
    a.maxVoteCount === b.maxVoteCount &&
    a.genreIds.length === b.genreIds.length &&
    a.genreIds.every((id) => b.genreIds.includes(id))
  );
}
