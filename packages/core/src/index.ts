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

export interface MediaDetails extends MediaSummary {
  imdbId: string | null;
  genres: string[];
  runtime: number | null;
  numberOfSeasons: number | null;
}

export interface Stream {
  name: string;
  title: string;
  infoHash: string;
  fileIdx: number | null;
  quality: string | null;
  sizeBytes: number | null;
  seeders: number | null;
}

export interface CuboClientConfig {
  baseUrl?: string;
}

export interface CuboClient {
  tmdb: {
    trending(mediaType: MediaType, timeWindow?: 'day' | 'week'): Promise<MediaSummary[]>;
    details(mediaType: MediaType, id: number): Promise<MediaDetails>;
    search(query: string): Promise<MediaSummary[]>;
  };
  streams: {
    get(mediaType: MediaType, imdbId: string, season?: number, episode?: number): Promise<Stream[]>;
  };
}

type TmdbListItem = {
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

type TmdbDetailsRaw = TmdbListItem & {
  imdb_id?: string | null;
  external_ids?: { imdb_id?: string | null };
  genres?: { name: string }[];
  runtime?: number | null;
  number_of_seasons?: number | null;
};

type TmdbListResponse = {
  results?: TmdbListItem[];
};

type TorrentioStreamRaw = {
  name?: string;
  title?: string;
  infoHash?: string;
  fileIdx?: number | null;
  behaviorHints?: { videoSize?: number };
};

function toSummary(item: TmdbListItem, mediaType: MediaType): MediaSummary {
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

function toDetails(item: TmdbDetailsRaw, mediaType: MediaType): MediaDetails {
  return {
    ...toSummary(item, mediaType),
    imdbId: item.external_ids?.imdb_id ?? item.imdb_id ?? null,
    genres: (item.genres ?? []).map((genre) => genre.name),
    runtime: item.runtime ?? null,
    numberOfSeasons: item.number_of_seasons ?? null,
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
    infoHash: raw.infoHash ?? '',
    fileIdx: raw.fileIdx ?? null,
    quality: qualityMatch ? qualityMatch[1] : null,
    sizeBytes: raw.behaviorHints?.videoSize ?? null,
    seeders: parseSeeders(title),
  };
}

function parseSeeders(title: string): number | null {
  const match = SEEDERS_RE.exec(title);
  return match ? Number(match[1]) : null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status} ${res.statusText}): ${url}`);
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
        return (data.results ?? []).map((item) => toSummary(item, mediaType));
      },
      async details(mediaType, id) {
        const data = await request<TmdbDetailsRaw>(
          `/api/tmdb/${mediaType}/${id}?append_to_response=external_ids`,
        );
        return toDetails(data, mediaType);
      },
      async search(query) {
        const q = encodeURIComponent(query);
        const [movies, shows] = await Promise.all([
          request<TmdbListResponse>(`/api/tmdb/search/movie?query=${q}`),
          request<TmdbListResponse>(`/api/tmdb/search/tv?query=${q}`),
        ]);
        return [
          ...(movies.results ?? []).map((item) => toSummary(item, 'movie')),
          ...(shows.results ?? []).map((item) => toSummary(item, 'tv')),
        ];
      },
    },
    streams: {
      async get(mediaType, imdbId, season, episode) {
        const id =
          mediaType === 'tv' && season != null && episode != null
            ? `${imdbId}:${season}:${episode}`
            : imdbId;
        const data = await request<{ streams?: TorrentioStreamRaw[] }>(
          `/api/torrentio/stream/${mediaType}/${id}.json`,
        );
        return (data.streams ?? []).map(toStream);
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
