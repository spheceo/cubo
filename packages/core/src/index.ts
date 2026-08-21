export type MediaType = 'movie' | 'tv';

export interface MediaSummary {
  id: number;
  mediaType: MediaType;
  title: string;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string;
  voteAverage: number;
}

export interface SeasonSummary {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  airDate: string;
  posterPath: string | null;
}

export interface Episode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview: string;
  stillPath: string | null;
  airDate: string;
  runtime: number | null;
  voteAverage: number;
}

export interface UpcomingEpisode {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  airDate: string;
}

export interface MediaDetails extends MediaSummary {
  imdbId: string | null;
  /** ISO 639-1 language of the title's original audio. */
  originalLanguage: string | null;
  /** Transparent title treatment (logo) from TMDB, when one exists. */
  logoPath: string | null;
  genres: string[];
  runtime: number | null;
  numberOfSeasons: number | null;
  seasons: SeasonSummary[];
  /** Next episode TMDB/Cinemeta says has not aired yet. */
  nextEpisode: UpcomingEpisode | null;
}

export interface Stream {
  name: string;
  title: string;
  filename: string | null;
  infoHash: string;
  fileIdx: number | null;
  quality: string | null;
  sizeBytes: number | null;
  seeders: number | null;
  /** Tracker URLs from Torrentio (`tracker:` prefix stripped) — used to build magnet links. */
  trackers: string[];
}

export interface SubtitleTrack {
  id: string;
  url: string;
  language: string;
}

export interface LibraryItem {
  key: string;
  mediaId: number;
  mediaType: MediaType;
  imdbId: string | null;
  title: string;
  subtitle: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  logoPath: string | null;
  season: number | null;
  episode: number | null;
  positionSeconds: number;
  durationSeconds: number;
  progress: number;
  completed: boolean;
  lastWatchedAt: number;
  watchHref: string;
  detailHref: string;
}

export interface WatchLaterItem {
  key: string;
  mediaId: number;
  mediaType: MediaType;
  imdbId: string | null;
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  watchHref: string;
  detailHref: string;
  savedAt: number;
}

export interface WatchAnalytics {
  totalWatchSeconds: number;
  playSessions: number;
  titlesStarted: number;
  titlesCompleted: number;
  lastWatchedAt: number | null;
}

export interface CachePreferences {
  maxBytes: number;
  directory?: string | null;
}

export interface CacheEntry {
  torrentId: number | null;
  infoHash: string;
  mediaKey: string | null;
  title: string | null;
  /** Absolute paths of the downloaded files on the Core machine. */
  files: string[];
  lastAccessedAt: number;
}

export interface CoreLibrarySnapshot {
  version: number;
  history: LibraryItem[];
  watchLater: WatchLaterItem[];
  analytics: WatchAnalytics;
  cache: CachePreferences;
  cacheEntries: CacheEntry[];
}

export interface CuboClientConfig {
  baseUrl?: string;
  /** Metadata source: 'tmdb' (default; needs TMDB_API_KEY server-side) or
   *  'cinemeta' (keyless Stremio catalog service). */
  metadataProvider?: 'tmdb' | 'cinemeta';
}

export interface CuboClient {
  tmdb: {
    trending(mediaType: MediaType, timeWindow?: 'day' | 'week'): Promise<MediaSummary[]>;
    collection(
      mediaType: MediaType,
      collection: 'popular' | 'top_rated' | 'current',
    ): Promise<MediaSummary[]>;
    details(mediaType: MediaType, id: number): Promise<MediaDetails>;
    season(id: number, seasonNumber: number): Promise<Episode[]>;
    search(query: string): Promise<MediaSummary[]>;
  };
  streams: {
    get(mediaType: MediaType, imdbId: string, season?: number, episode?: number): Promise<Stream[]>;
  };
  subtitles: {
    get(
      mediaType: MediaType,
      imdbId: string,
      season?: number,
      episode?: number,
      release?: SubtitleReleaseHint | null,
    ): Promise<SubtitleTrack[]>;
  };
}

/** Identifies the EXACT release being played, so subtitle providers can
 *  machine-match a synced track instead of guessing by title ID alone. */
export interface SubtitleReleaseHint {
  videoHash?: string;
  videoSize?: number;
  filename?: string;
}

export type TmdbListItemRaw = {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
};

export type TmdbDetailsRaw = TmdbListItemRaw & {
  imdb_id?: string | null;
  original_language?: string | null;
  external_ids?: { imdb_id?: string | null };
  genres?: { name: string }[];
  runtime?: number | null;
  episode_run_time?: number[];
  number_of_seasons?: number | null;
  seasons?: TmdbSeasonRaw[];
  images?: { logos?: TmdbImageRaw[] };
  next_episode_to_air?: TmdbEpisodeRaw | null;
};

export type TmdbImageRaw = {
  file_path?: string;
  iso_639_1?: string | null;
  width?: number;
};

export type TmdbSeasonRaw = {
  season_number?: number;
  name?: string;
  episode_count?: number;
  air_date?: string | null;
  poster_path?: string | null;
};

export type TmdbEpisodeRaw = {
  id: number;
  season_number?: number;
  episode_number?: number;
  name?: string;
  overview?: string;
  still_path?: string | null;
  air_date?: string | null;
  runtime?: number | null;
  vote_average?: number;
};

export type TmdbListResponse = {
  results?: TmdbListItemRaw[];
};

type TorrentioStreamRaw = {
  name?: string;
  title?: string;
  infoHash?: string;
  fileIdx?: number | null;
  behaviorHints?: { filename?: string; videoSize?: number };
  sources?: string[];
};

type SubtitleRaw = {
  id?: string;
  url?: string;
  lang?: string;
};

// ---------------------------------------------------------------------------
// Cinemeta — Stremio's public, keyless metadata service. Used as the default
// metadata provider so the app runs without a TMDB key at all.
//
// Shape of the integration (verified against the live service):
//   catalogs  /catalog/{movie|series}/top[/{extra}].json   extras: search, genre, skip
//   meta      /meta/{movie|series}/{imdb_id}.json          IMDb ids only — no tmdb: prefix
//
// Cinemeta metas carry BOTH ids (id = tt…, moviedb_id = numeric). The app
// routes by the numeric id, so every catalog/search result is remembered in a
// tmdb→imdb map; details() resolves through it. A cold deep link to an id no
// catalog page mentioned cannot be resolved without a key — that limitation
// is inherent to going keyless.
// ---------------------------------------------------------------------------

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';

type CinemetaVideo = {
  name?: string;
  season?: number;
  episode?: number;
  released?: string;
  thumbnail?: string | null;
  overview?: string | null;
};

type CinemetaMeta = {
  id?: string;
  moviedb_id?: number | string;
  imdb_id?: string | null;
  name?: string;
  description?: string;
  poster?: string | null;
  background?: string | null;
  logo?: string | null;
  genres?: string[];
  runtime?: string;
  releaseInfo?: string;
  imdbRating?: number | string;
  videos?: CinemetaVideo[];
};

type CinemetaCatalogResponse = { metas?: CinemetaMeta[] };
type CinemetaMetaResponse = { meta?: CinemetaMeta };

function firstYear(releaseInfo?: string): string {
  return releaseInfo?.match(/\d{4}/)?.[0] ?? '';
}

function parseRuntimeMinutes(runtime?: string): number | null {
  const minutes = runtime?.match(/(\d+)\s*min/)?.[1];
  return minutes ? Number(minutes) : null;
}

/** Cinemeta names TV shows 'series', not 'tv'. */
function cineType(mediaType: MediaType): 'movie' | 'series' {
  return mediaType === 'tv' ? 'series' : 'movie';
}

class CinemetaMetadata {
  /** Numeric route ids are TMDB ids; this bridges them to IMDb ids. */
  private bridge = new Map<number, string>();
  private metaCache = new Map<string, CinemetaMeta>();

  private trackPair(numericId: number, imdbId: string): void {
    if (Number.isSafeInteger(numericId) && numericId > 0 && imdbId.startsWith('tt')) {
      this.bridge.set(numericId, imdbId);
    }
  }

  /** Records the tmdb→imdb pair when the meta carries both ids. */
  private remember(meta: CinemetaMeta): void {
    const tmdbId = Number(meta.moviedb_id);
    if (Number.isFinite(tmdbId) && tmdbId > 0 && meta.id) {
      this.trackPair(tmdbId, meta.id);
    }
  }

  /** Public because catalog/search mapping lives outside the class.
   *  Search results carry no moviedb_id, so callers pass an id derived
   *  from the IMDb number instead. */
  trackId(meta: CinemetaMeta, forcedNumericId?: number): void {
    const imdb = meta.id?.startsWith('tt') ? meta.id : meta.imdb_id ?? null;
    if (!imdb) return;
    const tmdbId = Number(meta.moviedb_id);
    this.trackPair(
      Number.isFinite(tmdbId) && tmdbId > 0 ? tmdbId : (forcedNumericId ?? NaN),
      imdb,
    );
  }

  async catalog(
    mediaType: MediaType,
    extra?: string,
  ): Promise<CinemetaMeta[]> {
    const suffix = extra ? `/${extra}` : '';
    const data = await getJson<CinemetaCatalogResponse>(
      `${CINEMETA_BASE}/catalog/${cineType(mediaType)}/top${suffix}.json`,
    );
    return data.metas ?? [];
  }

  async resolveImdb(mediaType: MediaType, id: number): Promise<string> {
    const cached = this.bridge.get(id);
    if (cached) return cached;
    // Cold deep link (old history entry): warm the map from popular catalogs
    // before giving up.
    for (const type of ['movie', 'series'] as MediaType[]) {
      try {
        for (const meta of await this.catalog(type)) this.remember(meta);
      } catch {
        // Catalog failure just means the miss stands.
      }
    }
    const imdb = this.bridge.get(id);
    if (!imdb) {
      throw new Error('This title is not in the connected catalog right now.');
    }
    return imdb;
  }

  async meta(mediaType: MediaType, id: number): Promise<CinemetaMeta> {
    const imdb = await this.resolveImdb(mediaType, id);
    const cacheKey = `${mediaType}:${imdb}`;
    const cached = this.metaCache.get(cacheKey);
    if (cached) return cached;
    const data = await getJson<CinemetaMetaResponse>(
      `${CINEMETA_BASE}/meta/${cineType(mediaType)}/${imdb}.json`,
    );
    const meta = data.meta;
    if (!meta) throw new Error('The catalog has no record of this title.');
    this.remember(meta);
    this.metaCache.set(cacheKey, meta);
    return meta;
  }
}

/** Maps one Cinemeta meta to the app's summary shape. Items without any
 *  usable id (no moviedb_id AND a too-short IMDb number) are dropped. */
function cinemetaSummary(
  provider: CinemetaMetadata,
  meta: CinemetaMeta,
  mediaType: MediaType,
): MediaSummary | null {
  const imdb = meta.id?.startsWith('tt') ? meta.id : meta.imdb_id ?? null;
  let numericId = Number(meta.moviedb_id);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    // Search metas lack moviedb_id — fall back to the IMDb number so the
    // title still routes, and register that exact pairing for details().
    const digits = imdb?.replace(/\D/g, '') ?? '';
    if (digits.length < 6) return null;
    numericId = Number(digits);
  }
  if (!imdb) return null;
  provider.trackId(meta, numericId);
  return {
    id: numericId,
    mediaType,
    title: meta.name ?? '',
    overview: meta.description ?? '',
    posterPath: meta.poster ?? null,
    backdropPath: meta.background ?? null,
    releaseDate: firstYear(meta.releaseInfo),
    voteAverage: Number(meta.imdbRating) || 0,
  };
}

function cinemetaDetails(
  routeId: number,
  mediaType: MediaType,
  meta: CinemetaMeta,
): MediaDetails {
  const videos = meta.videos ?? [];
  const seasonNumbers = [
    ...new Set(videos.map((video) => video.season).filter((s): s is number => s != null)),
  ].sort((a, b) => a - b);

  return {
    ...normalizeSummary(
      {
        id: Number(meta.moviedb_id) || routeId,
        title: meta.name ?? '',
        overview: meta.description ?? '',
        poster_path: meta.poster ?? null,
        backdrop_path: meta.background ?? null,
        release_date: firstYear(meta.releaseInfo),
        vote_average: Number(meta.imdbRating) || 0,
      },
      mediaType,
    ),
    imdbId: meta.imdb_id ?? meta.id ?? null,
    originalLanguage: null,
    logoPath: meta.logo ?? null,
    genres: meta.genres ?? [],
    runtime: parseRuntimeMinutes(meta.runtime),
    numberOfSeasons: mediaType === 'tv' ? seasonNumbers.length || null : null,
    seasons:
      mediaType === 'tv'
        ? seasonNumbers.map((seasonNumber) => ({
            seasonNumber,
            name: `Season ${seasonNumber}`,
            episodeCount: videos.filter((video) => video.season === seasonNumber).length,
            airDate: '',
            posterPath: null,
          }))
        : [],
    nextEpisode: upcomingFromVideos(videos),
  };
}

/** English logos first, then language-neutral ones; PNG beats SVG for the fill mask. */
function pickLogo(logos: TmdbImageRaw[]): string | null {
  const usable = logos.filter((logo) => Boolean(logo.file_path));
  const score = (logo: TmdbImageRaw) =>
    (logo.iso_639_1 === 'en' ? 0 : logo.iso_639_1 ? 2 : 1) +
    (logo.file_path?.endsWith('.svg') ? 0.5 : 0);
  return [...usable].sort((a, b) => score(a) - score(b))[0]?.file_path ?? null;
}

export function normalizeSummary(item: TmdbListItemRaw, mediaType: MediaType): MediaSummary {
  return {
    id: item.id,
    mediaType,
    title: item.title ?? item.name ?? '',
    overview: item.overview ?? '',
    posterPath: item.poster_path ?? null,
    backdropPath: item.backdrop_path ?? null,
    releaseDate: item.release_date ?? item.first_air_date ?? '',
    voteAverage: item.vote_average ?? 0,
  };
}

export function normalizeDetails(item: TmdbDetailsRaw, mediaType: MediaType): MediaDetails {
  return {
    ...normalizeSummary(item, mediaType),
    imdbId: item.external_ids?.imdb_id ?? item.imdb_id ?? null,
    originalLanguage: item.original_language ?? null,
    logoPath: pickLogo(item.images?.logos ?? []),
    genres: (item.genres ?? []).map((genre) => genre.name),
    runtime: item.runtime ?? item.episode_run_time?.[0] ?? null,
    numberOfSeasons: item.number_of_seasons ?? null,
    seasons: (item.seasons ?? [])
      .filter((season) => (season.season_number ?? 0) > 0 && (season.episode_count ?? 0) > 0)
      .map((season) => ({
        seasonNumber: season.season_number ?? 0,
        name: season.name ?? '',
        episodeCount: season.episode_count ?? 0,
        airDate: season.air_date ?? '',
        posterPath: season.poster_path ?? null,
      })),
    nextEpisode: upcomingFromTmdb(item.next_episode_to_air),
  };
}

function upcomingFromTmdb(episode: TmdbEpisodeRaw | null | undefined): UpcomingEpisode | null {
  if (!episode?.air_date || (episode.season_number ?? 0) < 1) return null;
  if (!isUpcomingDate(episode.air_date)) return null;
  return {
    seasonNumber: episode.season_number ?? 0,
    episodeNumber: episode.episode_number ?? 0,
    name: episode.name ?? '',
    airDate: episode.air_date,
  };
}

function upcomingFromVideos(videos: CinemetaVideo[]): UpcomingEpisode | null {
  const upcoming = videos
    .filter((video) => (video.season ?? 0) > 0 && (video.episode ?? 0) > 0 && video.released)
    .map((video) => ({
      seasonNumber: video.season ?? 0,
      episodeNumber: video.episode ?? 0,
      name: video.name ?? '',
      airDate: video.released!.slice(0, 10),
    }))
    .filter((episode) => isUpcomingDate(episode.airDate))
    .sort((left, right) => left.airDate.localeCompare(right.airDate));
  return upcoming[0] ?? null;
}

function isUpcomingDate(airDate: string): boolean {
  const parsed = parseCalendarDate(airDate);
  if (!parsed) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parsed.getTime() >= today.getTime();
}

function parseCalendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeEpisode(episode: TmdbEpisodeRaw): Episode {
  return {
    id: episode.id,
    seasonNumber: episode.season_number ?? 0,
    episodeNumber: episode.episode_number ?? 0,
    name: episode.name ?? '',
    overview: episode.overview ?? '',
    stillPath: episode.still_path ?? null,
    airDate: episode.air_date ?? '',
    runtime: episode.runtime ?? null,
    voteAverage: episode.vote_average ?? 0,
  };
}

const QUALITY_RE = /\b(2160p|1080p|720p|480p)\b/i;
const SEEDERS_RE = /👤\s*(\d+)/;

function toStream(raw: TorrentioStreamRaw): Stream {
  const name = raw.name ?? '';
  const title = raw.title ?? '';
  const qualityMatch = QUALITY_RE.exec(`${name} ${title}`);

  return {
    name,
    title,
    filename: raw.behaviorHints?.filename ?? null,
    infoHash: raw.infoHash ?? '',
    fileIdx: raw.fileIdx ?? null,
    quality: qualityMatch ? qualityMatch[1] : null,
    sizeBytes: raw.behaviorHints?.videoSize ?? null,
    seeders: parseSeeders(title),
    trackers: (raw.sources ?? [])
      .filter((source) => source.startsWith('tracker:'))
      .map((source) => source.slice('tracker:'.length)),
  };
}

function parseSeeders(title: string): number | null {
  const match = SEEDERS_RE.exec(title);
  return match ? Number(match[1]) : null;
}

/** Alternates two ranked lists (movie, show, movie, …) so neither media type
 *  buries the other in mixed search results. */
function interleave<T>(left: T[], right: T[]): T[] {
  const merged: T[] = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index]) merged.push(left[index]);
    if (right[index]) merged.push(right[index]);
  }
  return merged;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === 'string') detail = body.error;
    } catch {
      // Non-JSON error bodies fall through to the generic message.
    }
    throw new Error(detail || `Request failed (${res.status} ${res.statusText}): ${url}`);
  }
  return (await res.json()) as T;
}

export function createClient(config?: CuboClientConfig): CuboClient {
  const baseUrl = (config?.baseUrl ?? '').replace(/\/$/, '');

  const request = <T>(path: string) => getJson<T>(`${baseUrl}${path}`);

  // --- TMDB over the deployed proxy. Requires a server-side key; kept as the
  // rollback path while Cinemeta is under evaluation. ---
  const tmdbOverProxy = {
    async trending(mediaType: MediaType, timeWindow: 'day' | 'week' = 'week') {
      const data = await request<TmdbListResponse>(
        `/api/tmdb/trending/${mediaType}/${timeWindow}`,
      );
      return (data.results ?? []).map((item) => normalizeSummary(item, mediaType));
    },
    async details(mediaType: MediaType, id: number) {
      // No `credits` in append_to_response: cast is not rendered anywhere,
      // and omitting it keeps every cached details payload small.
      const data = await request<TmdbDetailsRaw>(
        `/api/tmdb/${mediaType}/${id}?append_to_response=external_ids,images&include_image_language=en,null`,
      );
      return normalizeDetails(data, mediaType);
    },
    async season(id: number, seasonNumber: number) {
      const data = await request<{ episodes?: TmdbEpisodeRaw[] }>(
        `/api/tmdb/tv/${id}/season/${seasonNumber}`,
      );
      return (data.episodes ?? []).map(normalizeEpisode);
    },
      async collection(mediaType: MediaType, collection: 'popular' | 'top_rated' | 'current') {
        const endpoint =
          collection === 'current'
            ? mediaType === 'movie'
              ? 'now_playing'
              : 'on_the_air'
            : collection;
        const data = await request<TmdbListResponse>(`/api/tmdb/${mediaType}/${endpoint}`);
        return (data.results ?? [])
          .filter((item) => item.poster_path || item.backdrop_path)
          .map((item) => normalizeSummary(item, mediaType));
      },
      async search(query: string) {
        const q = encodeURIComponent(query);
        const [movies, shows] = await Promise.all([
          request<TmdbListResponse>(`/api/tmdb/search/movie?query=${q}`),
          request<TmdbListResponse>(`/api/tmdb/search/tv?query=${q}`),
        ]);
        return interleave(
          (movies.results ?? []).map((item) => normalizeSummary(item, 'movie')),
          (shows.results ?? []).map((item) => normalizeSummary(item, 'tv')),
        );
      },
  };

  // --- Cinemeta: the keyless default ---
  const cinemeta = new CinemetaMetadata();

  const tmdbOverCinemeta = {
    async trending(mediaType: MediaType) {
      const metas = await cinemeta.catalog(mediaType);
      return metas
        .map((meta) => cinemetaSummary(cinemeta, meta, mediaType))
        .filter((item): item is MediaSummary => item !== null);
    },
    async collection(
      mediaType: MediaType,
      _collection: 'popular' | 'top_rated' | 'current',
    ) {
      // Cinemeta's lean manifest exposes a single ranked catalog, so every
      // collection maps onto it for now.
      return tmdbOverCinemeta.trending(mediaType);
    },
    async details(mediaType: MediaType, id: number) {
      const meta = await cinemeta.meta(mediaType, id);
      return cinemetaDetails(id, mediaType, meta);
    },
    async season(showId: number, seasonNumber: number) {
      const imdb = await cinemeta.resolveImdb('tv', showId);
      const data = await getJson<CinemetaMetaResponse>(
        `${CINEMETA_BASE}/meta/series/${imdb}.json`,
      );
      const videos = data.meta?.videos ?? [];
      return videos
        .filter((video) => video.season === seasonNumber)
        .map((video, index): Episode => {
          const episodeNumber = video.episode ?? index + 1;
          return {
            id: seasonNumber * 100000 + episodeNumber,
            seasonNumber,
            episodeNumber,
            name: video.name ?? `Episode ${episodeNumber}`,
            overview: video.overview ?? '',
            stillPath: video.thumbnail ?? null,
            airDate: video.released?.slice(0, 10) ?? '',
            runtime: null,
            voteAverage: 0,
          };
        });
    },
    async search(query: string) {
      const q = encodeURIComponent(query);
      const [movies, shows] = await Promise.all([
        getJson<CinemetaCatalogResponse>(`${CINEMETA_BASE}/catalog/movie/search=${q}.json`),
        getJson<CinemetaCatalogResponse>(`${CINEMETA_BASE}/catalog/series/search=${q}.json`),
      ]);
      return interleave(
        (movies.metas ?? [])
          .map((meta) => cinemetaSummary(cinemeta, meta, 'movie'))
          .filter((item): item is MediaSummary => item !== null),
        (shows.metas ?? [])
          .map((meta) => cinemetaSummary(cinemeta, meta, 'tv'))
          .filter((item): item is MediaSummary => item !== null),
      );
    },
  };

  return {
    tmdb:
      config?.metadataProvider === 'cinemeta' ? tmdbOverCinemeta : tmdbOverProxy,
    streams: {
      async get(mediaType, imdbId, season, episode) {
        const addonType = mediaType === 'tv' ? 'series' : 'movie';
        const id =
          mediaType === 'tv' && season != null && episode != null
            ? `${imdbId}:${season}:${episode}`
            : imdbId;
        const data = await request<{ streams?: TorrentioStreamRaw[] }>(
          `/api/torrentio/stream/${addonType}/${id}.json`,
        );
        return (data.streams ?? []).map(toStream);
      },
    },
    subtitles: {
      async get(
        mediaType: MediaType,
        imdbId: string,
        season?: number,
        episode?: number,
        release?: SubtitleReleaseHint | null,
      ) {
        const addonType = mediaType === 'tv' ? 'series' : 'movie';
        const id =
          mediaType === 'tv' && season != null && episode != null
            ? `${imdbId}:${season}:${episode}`
            : imdbId;
        const params = new URLSearchParams();
        if (release?.videoHash) params.set('videoHash', release.videoHash);
        if (release?.videoSize != null) params.set('videoSize', String(release.videoSize));
        if (release?.filename) params.set('filename', release.filename);
        const search = params.toString();
        const data = await request<{ subtitles?: SubtitleRaw[] }>(
          `/api/subtitles/subtitles/${addonType}/${id}.json${search ? `?${search}` : ''}`,
        );
        return (data.subtitles ?? [])
          .filter((track) => track.id && track.url && track.lang)
          .map((track) => ({
            id: track.id as string,
            url: track.url as string,
            language: track.lang as string,
          }));
      },
    },
  };
}

export function posterUrl(
  path: string | null,
  size: 'w185' | 'w342' | 'w500' | 'original' = 'w500',
): string {
  if (!path) return '';
  // Providers that hand back ready-to-use URLs pass through untouched.
  return path.startsWith('http') ? path : `https://image.tmdb.org/t/p/${size}${path}`;
}

export function backdropUrl(
  path: string | null,
  size: 'w780' | 'w1280' | 'original' = 'w1280',
): string {
  if (!path) return '';
  return path.startsWith('http') ? path : `https://image.tmdb.org/t/p/${size}${path}`;
}

export function logoUrl(path: string | null, size: 'w300' | 'w500' | 'original' = 'w500'): string {
  if (!path) return '';
  return path.startsWith('http') ? path : `https://image.tmdb.org/t/p/${size}${path}`;
}

export function stillUrl(path: string | null, size: 'w300' | 'w780' = 'w300'): string {
  if (!path) return '';
  return path.startsWith('http') ? path : `https://image.tmdb.org/t/p/${size}${path}`;
}

export function titleHref(item: Pick<MediaSummary, 'id' | 'mediaType'>): string {
  return `/${item.mediaType}/${item.id}`;
}

export function watchHref(
  item: Pick<MediaSummary, 'id' | 'mediaType'>,
  season?: number,
  episode?: number,
): string {
  const base = `/watch/${item.mediaType}/${item.id}`;
  return season != null && episode != null ? `${base}?season=${season}&episode=${episode}` : base;
}
