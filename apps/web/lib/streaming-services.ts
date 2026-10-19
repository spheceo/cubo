import type { WatchProvider } from '@cubo/core';

/**
 * The streaming services the viewer subscribes to, and the country whose
 * catalogues they see. Persisted locally like the other viewer prefs.
 * Until the viewer picks, the region is guessed from the browser and the
 * services are the region's most prominent ones.
 */

const STORAGE_KEY = 'cubo.services.v1';

/** How many services show before the viewer has picked any. */
export const DEFAULT_SERVICE_COUNT = 4;

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

/** Well-known subscription services (TMDB provider ids). TMDB's per-country
 *  list mixes rental stores (Apple TV Store, BoxOffice) in with them, so the
 *  defaults come from these. */
const SUBSCRIPTION_SERVICES = new Set([
  8, // Netflix
  9, // Amazon Prime Video
  119, // Amazon Prime Video (outside the US)
  337, // Disney Plus
  350, // Apple TV+
  1899, // Max
  384, // HBO Max
  15, // Hulu
  531, // Paramount Plus
  386, // Peacock
  283, // Crunchyroll
  39, // NOW
  230, // Crave
  381, // Canal+
  55, // Showmax
]);

/** The viewer's picks in their order, skipping services the region lacks;
 *  until they have picked, the region's leading subscription services. */
export function chosenServices(all: WatchProvider[], ids?: number[]): WatchProvider[] {
  if (!ids) {
    const subscriptions = all.filter((provider) => SUBSCRIPTION_SERVICES.has(provider.id));
    return (subscriptions.length ? subscriptions : all).slice(0, DEFAULT_SERVICE_COUNT);
  }
  const byId = new Map(all.map((provider) => [provider.id, provider]));
  return ids.flatMap((id) => {
    const provider = byId.get(id);
    return provider ? [provider] : [];
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
