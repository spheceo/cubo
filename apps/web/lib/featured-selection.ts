import type { MediaSummary } from '@cubo/core';

const STORAGE_KEY = 'cubo.featured.v2';
const LEGACY_KEY = 'cubo.featured.v1';

/** Featured heroes should feel current. Older titles stay in the rows. */
export const FEATURED_MAX_AGE_YEARS = 10;

/** Featured heroes should feel curated, not arbitrary: below this score the
 *  pool falls back to whatever is eligible rather than headline obscure picks. */
export const FEATURED_MIN_VOTE = 7;

/** Keep the same billboard across refreshes; rotate after this, not every load. */
export const FEATURED_HOLD_MS = 6 * 60 * 60 * 1000;

export type FeaturedHold = { key: string; until: number };

type FeaturedStore = {
  history: string[];
  holds: Record<string, FeaturedHold>;
};

let memory: FeaturedStore = { history: [], holds: {} };

const titleKey = (item: MediaSummary) => `${item.mediaType}:${item.id}`;

function releaseYear(value: string): number | null {
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) && year > 1800 ? year : null;
}

export function isFeaturedEligible(
  item: Pick<MediaSummary, 'backdropPath' | 'releaseDate'>,
  today: string,
): boolean {
  if (!item.backdropPath || !item.releaseDate) return false;
  if (item.releaseDate.slice(0, 10) > today) return false;
  const year = releaseYear(item.releaseDate);
  const todayYear = releaseYear(today);
  if (year == null || todayYear == null) return false;
  return year >= todayYear - FEATURED_MAX_AGE_YEARS;
}

function parseStore(value: unknown): FeaturedStore | null {
  if (Array.isArray(value) && value.every((key) => typeof key === 'string')) {
    return { history: value, holds: {} };
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as { history?: unknown; holds?: unknown };
  if (!Array.isArray(record.history) || !record.history.every((key) => typeof key === 'string')) {
    return null;
  }
  const holds: Record<string, FeaturedHold> = {};
  if (record.holds && typeof record.holds === 'object') {
    for (const [scope, hold] of Object.entries(record.holds as Record<string, unknown>)) {
      if (!hold || typeof hold !== 'object') continue;
      const { key, until } = hold as FeaturedHold;
      if (typeof key === 'string' && typeof until === 'number') holds[scope] = { key, until };
    }
  }
  return { history: record.history, holds };
}

function readStore(): FeaturedStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY);
    const parsed = parseStore(JSON.parse(raw ?? 'null'));
    if (parsed) {
      memory = parsed;
      return parsed;
    }
  } catch {
    // In-memory rotation still works when storage is unavailable.
  }
  return memory;
}

function writeStore(store: FeaturedStore) {
  memory = store;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Best effort across refreshes.
  }
}

/** Prefer unseen titles, then the least recently featured. Catalog ranking
 * determines the pool, not a permanent hero at index zero. */
export function pickFeatured(
  candidates: MediaSummary[],
  history: string[],
  random = Math.random(),
  today = new Date().toISOString().slice(0, 10),
): MediaSummary | null {
  const unique = new Map(candidates.map((item) => [titleKey(item), item]));
  const eligible = [...unique.values()].filter((item) => isFeaturedEligible(item, today));
  if (eligible.length === 0) return null;
  // Rotation stays, but only over titles worth headlining. If every eligible
  // pick is unrated or poorly rated, showing one beats showing nothing.
  const curated = eligible.filter((item) => item.voteAverage >= FEATURED_MIN_VOTE);
  const rotationSet = curated.length > 0 ? curated : eligible;
  const oldest = Math.min(...rotationSet.map((item) => history.indexOf(titleKey(item))));
  const pool = rotationSet.filter((item) => history.indexOf(titleKey(item)) === oldest);
  const fraction = Number.isFinite(random) ? Math.max(0, Math.min(random, 0.999999)) : 0;
  return pool[Math.floor(fraction * pool.length)];
}

export function resolveFeatured(
  candidates: MediaSummary[],
  history: string[],
  hold: FeaturedHold | null,
  now: number,
  random = Math.random(),
  today = new Date(now).toISOString().slice(0, 10),
): { item: MediaSummary | null; history: string[]; hold: FeaturedHold | null } {
  if (hold && now < hold.until) {
    const kept = candidates.find(
      (item) => titleKey(item) === hold.key && isFeaturedEligible(item, today),
    );
    if (kept) return { item: kept, history, hold };
  }

  const item = pickFeatured(candidates, history, random, today);
  if (!item) return { item: null, history, hold: null };
  const key = titleKey(item);
  return {
    item,
    history: [...history.filter((entry) => entry !== key), key].slice(-100),
    hold: { key, until: now + FEATURED_HOLD_MS },
  };
}

export function nextFeatured(
  candidates: MediaSummary[],
  scope = 'home',
  now = Date.now(),
): MediaSummary | null {
  const store = readStore();
  const resolved = resolveFeatured(candidates, store.history, store.holds[scope] ?? null, now);
  if (resolved.hold) store.holds[scope] = resolved.hold;
  else delete store.holds[scope];
  store.history = resolved.history;
  writeStore(store);
  return resolved.item;
}
