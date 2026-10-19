import type { MediaSummary, WatchProvider } from '@cubo/core';

/**
 * The streaming services the viewer subscribes to, and the country whose
 * catalogues they see. Persisted locally like the other viewer prefs.
 * Until the viewer picks, the country is guessed from the browser and the
 * services are the big four. The country only orders things (which
 * services list first, what ranks top); catalogues span countries.
 */

const STORAGE_KEY = 'cubo.services.v1';

export interface ServicePrefs {
  region?: string;
  /** Provider ids in the viewer's order; absent until they pick. */
  ids?: number[];
}

/** Time zones say where someone is better than the UI language does: a
 *  Mac set to US English in South Africa still reports Africa/Johannesburg. */
const ZONE_REGIONS: Record<string, string> = {
  'Africa/Johannesburg': 'ZA',
  'Africa/Lagos': 'NG',
  'Africa/Nairobi': 'KE',
  'Africa/Cairo': 'EG',
  'Africa/Casablanca': 'MA',
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Phoenix': 'US',
  'America/Los_Angeles': 'US',
  'America/Anchorage': 'US',
  'Pacific/Honolulu': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA',
  'America/Halifax': 'CA',
  'America/Mexico_City': 'MX',
  'America/Sao_Paulo': 'BR',
  'America/Argentina/Buenos_Aires': 'AR',
  'America/Bogota': 'CO',
  'America/Santiago': 'CL',
  'America/Lima': 'PE',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL',
  'Europe/Brussels': 'BE',
  'Europe/Zurich': 'CH',
  'Europe/Vienna': 'AT',
  'Europe/Stockholm': 'SE',
  'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK',
  'Europe/Helsinki': 'FI',
  'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ',
  'Europe/Lisbon': 'PT',
  'Europe/Athens': 'GR',
  'Europe/Istanbul': 'TR',
  'Europe/Kyiv': 'UA',
  'Asia/Dubai': 'AE',
  'Asia/Riyadh': 'SA',
  'Asia/Jerusalem': 'IL',
  'Asia/Kolkata': 'IN',
  'Asia/Calcutta': 'IN',
  'Asia/Singapore': 'SG',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Bangkok': 'TH',
  'Asia/Jakarta': 'ID',
  'Asia/Manila': 'PH',
  'Asia/Hong_Kong': 'HK',
  'Asia/Taipei': 'TW',
  'Asia/Shanghai': 'CN',
  'Asia/Seoul': 'KR',
  'Asia/Tokyo': 'JP',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU',
  'Australia/Adelaide': 'AU',
  'Pacific/Auckland': 'NZ',
};

/** The viewer's country: time zone first, then a region on any of their
 *  browser languages, else the US. */
export function guessRegion(
  timeZone: string | undefined = safeTimeZone(),
  languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages,
): string {
  const fromZone = timeZone ? ZONE_REGIONS[timeZone] : undefined;
  if (fromZone) return fromZone;
  for (const language of languages) {
    const region = language.split('-').slice(1).find((part) => /^[A-Za-z]{2}$/.test(part));
    if (region) return region.toUpperCase();
  }
  return 'US';
}

function safeTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** "South Africa" for "ZA"; the code itself when the browser cannot say. */
export function regionName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Shown until the viewer picks their own: Netflix, Apple TV, Disney Plus,
 *  Amazon Prime Video. */
export const DEFAULT_SERVICE_IDS = [8, 350, 337, 9];

/** Countries with the largest catalogues. A service page merges these with
 *  the viewer's own so it shows the whole catalogue, not one country's. */
export const CATALOG_REGIONS = ['US', 'GB'];

/** Services in the viewer's country first (by TMDB's prominence there),
 *  then everything else by prominence across countries. */
export function rankServices(all: WatchProvider[], region: string): WatchProvider[] {
  return [...all].sort((a, b) => {
    const left = a.priorities[region];
    const right = b.priorities[region];
    if (left != null && right != null) return left - right || a.priority - b.priority;
    if (left != null) return -1;
    if (right != null) return 1;
    return a.priority - b.priority;
  });
}

/** The service a TMDB id belongs to, under any of its ids. */
export function findService(all: WatchProvider[], id: number): WatchProvider | undefined {
  return all.find((provider) => provider.ids.includes(id));
}

/** The viewer's picks in their order (the defaults until they pick),
 *  skipping ids TMDB no longer lists. */
export function chosenServices(all: WatchProvider[], ids?: number[]): WatchProvider[] {
  const picked: WatchProvider[] = [];
  for (const id of ids ?? DEFAULT_SERVICE_IDS) {
    const provider = findService(all, id);
    if (provider && !picked.includes(provider)) picked.push(provider);
  }
  return picked;
}

/** Where to read a service's catalogue from: the viewer's country and the
 *  big catalogues, where the service operates. A service in none of them
 *  uses its own leading countries. The first is the ranking country. */
export function catalogRegions(provider: WatchProvider, region: string): string[] {
  const pool = [...new Set([region, ...CATALOG_REGIONS])].filter(
    (code) => provider.priorities[code] != null,
  );
  if (pool.length) return pool;
  return Object.entries(provider.priorities)
    .sort(([, a], [, b]) => a - b)
    .slice(0, CATALOG_REGIONS.length)
    .map(([code]) => code);
}

export type CatalogOrder = 'popular' | 'newest' | 'rating';

/** One list from several countries' pages: each title once, in the row's
 *  order. Ties keep the earlier country's order, so the viewer's leads. */
export function mergeCatalog(lists: MediaSummary[][], order: CatalogOrder): MediaSummary[] {
  const seen = new Set<string>();
  const merged: MediaSummary[] = [];
  for (const item of lists.flat()) {
    const key = `${item.mediaType}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  const score = (item: MediaSummary): number | string =>
    order === 'newest'
      ? item.releaseDate
      : order === 'rating'
        ? item.voteAverage
        : (item.popularity ?? 0);
  return merged.sort((a, b) => {
    const left = score(a);
    const right = score(b);
    return left === right ? 0 : left > right ? -1 : 1;
  });
}

export function loadServicePrefs(): ServicePrefs {
  if (typeof window === 'undefined') return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return {};
    const { region, ids } = parsed as Record<string, unknown>;
    return {
      region: typeof region === 'string' && /^[A-Z]{2}$/.test(region) ? region : undefined,
      ids: Array.isArray(ids) ? ids.filter((id): id is number => Number.isInteger(id)) : undefined,
    };
  } catch {
    return {};
  }
}

export function saveServicePrefs(prefs: ServicePrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private-mode quota errors are fine to ignore; the pick just won't stick.
  }
}
