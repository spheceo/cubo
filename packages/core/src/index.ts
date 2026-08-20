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

export interface CastMember {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
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

export interface MediaDetails extends MediaSummary {
  imdbId: string | null;
  /** ISO 639-1 language of the title's original audio. */
  originalLanguage: string | null;
  tagline: string;
  /** Transparent title treatment (logo) from TMDB, when one exists. */
  logoPath: string | null;
  genres: string[];
  runtime: number | null;
  numberOfSeasons: number | null;
  seasons: SeasonSummary[];
  cast: CastMember[];
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
    recommendations(mediaType: MediaType, id: number): Promise<MediaSummary[]>;
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
    ): Promise<SubtitleTrack[]>;
  };
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
  tagline?: string | null;
  genres?: { name: string }[];
  runtime?: number | null;
  episode_run_time?: number[];
  number_of_seasons?: number | null;
  seasons?: TmdbSeasonRaw[];
  credits?: { cast?: TmdbCastRaw[] };
  aggregate_credits?: { cast?: TmdbCastRaw[] };
  images?: { logos?: TmdbImageRaw[] };
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

export type TmdbCastRaw = {
  id: number;
  name?: string;
  character?: string;
  roles?: { character?: string }[];
  profile_path?: string | null;
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

const MAX_CAST = 12;

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
  const cast = item.credits?.cast ?? item.aggregate_credits?.cast ?? [];

  return {
    ...normalizeSummary(item, mediaType),
    imdbId: item.external_ids?.imdb_id ?? item.imdb_id ?? null,
    originalLanguage: item.original_language ?? null,
    tagline: item.tagline ?? '',
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
    cast: cast.slice(0, MAX_CAST).map((member) => ({
      id: member.id,
      name: member.name ?? '',
      character: member.character ?? member.roles?.[0]?.character ?? '',
      profilePath: member.profile_path ?? null,
    })),
  };
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

  return {
    tmdb: {
      async trending(mediaType, timeWindow = 'week') {
        const data = await request<TmdbListResponse>(
          `/api/tmdb/trending/${mediaType}/${timeWindow}`,
        );
        return (data.results ?? []).map((item) => normalizeSummary(item, mediaType));
      },
      async details(mediaType, id) {
        const data = await request<TmdbDetailsRaw>(
          `/api/tmdb/${mediaType}/${id}?append_to_response=external_ids,credits,images&include_image_language=en,null`,
        );
        return normalizeDetails(data, mediaType);
      },
      async season(id, seasonNumber) {
        const data = await request<{ episodes?: TmdbEpisodeRaw[] }>(
          `/api/tmdb/tv/${id}/season/${seasonNumber}`,
        );
        return (data.episodes ?? []).map(normalizeEpisode);
      },
      async recommendations(mediaType, id) {
        const data = await request<TmdbListResponse>(
          `/api/tmdb/${mediaType}/${id}/recommendations`,
        );
        return (data.results ?? []).map((item) => normalizeSummary(item, mediaType));
      },
      async collection(mediaType, collection) {
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
      async search(query) {
        const q = encodeURIComponent(query);
        const [movies, shows] = await Promise.all([
          request<TmdbListResponse>(`/api/tmdb/search/movie?query=${q}`),
          request<TmdbListResponse>(`/api/tmdb/search/tv?query=${q}`),
        ]);
        const movieItems = (movies.results ?? []).map((item) => normalizeSummary(item, 'movie'));
        const showItems = (shows.results ?? []).map((item) => normalizeSummary(item, 'tv'));
        const merged: MediaSummary[] = [];
        const length = Math.max(movieItems.length, showItems.length);
        for (let index = 0; index < length; index += 1) {
          if (movieItems[index]) merged.push(movieItems[index]);
          if (showItems[index]) merged.push(showItems[index]);
        }
        return merged;
      },
    },
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
      async get(mediaType, imdbId, season, episode) {
        const addonType = mediaType === 'tv' ? 'series' : 'movie';
        const id =
          mediaType === 'tv' && season != null && episode != null
            ? `${imdbId}:${season}:${episode}`
            : imdbId;
        const data = await request<{ subtitles?: SubtitleRaw[] }>(
          `/api/subtitles/subtitles/${addonType}/${id}.json`,
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
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : '';
}

export function backdropUrl(
  path: string | null,
  size: 'w780' | 'w1280' | 'original' = 'w1280',
): string {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : '';
}

export function profileUrl(path: string | null, size: 'w185' | 'h632' = 'w185'): string {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : '';
}

export function logoUrl(path: string | null, size: 'w300' | 'w500' | 'original' = 'w500'): string {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : '';
}

export function stillUrl(path: string | null, size: 'w300' | 'w780' = 'w300'): string {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : '';
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
