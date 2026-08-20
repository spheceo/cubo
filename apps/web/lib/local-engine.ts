import type {
  CacheEntry,
  CoreLibrarySnapshot,
  MediaType,
  Stream,
  WatchLaterItem,
} from '@cubo/core';

export const CORE_PORT = 8765;
const DISCOVERY_TIMEOUT_MS = 4_000;

export interface LocalEngineConnection {
  baseUrl: string;
  port: number | null;
  token: string;
  version: string;
  /** True when this Core has ffmpeg and can remux MKV/incompatible-audio sources. */
  transcode: boolean;
}

export interface AddedTorrent {
  id: number | null;
  infoHash: string;
  files: { name: string; length: number }[];
}

export interface PlaybackUpdate {
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
  watchedDeltaSeconds: number;
  sessionStarted: boolean;
  watchHref: string;
  detailHref: string;
}

export interface CacheStatus {
  usedBytes: number;
  maxBytes: number;
  itemCount: number;
  entries: CacheEntry[];
}

type CoreRequestInit = RequestInit & {
  targetAddressSpace?: 'local' | 'loopback';
};

function isLoopbackHost(hostname: string) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

function coreFetch(url: string, init: RequestInit = {}) {
  const target = new URL(url);
  const isSameOrigin =
    typeof window !== 'undefined' && target.origin === window.location.origin;
  const isLoopback = isLoopbackHost(target.hostname);
  const pageIsLoopback =
    typeof window !== 'undefined' && isLoopbackHost(window.location.hostname);
  const options: CoreRequestInit = {
    ...init,
    mode: 'cors',
  };

  // targetAddressSpace is a Chromium Local Network Access hint. It is only
  // needed when a deployed HTTPS frontend reaches into the viewer's private
  // network. WKWebView and loopback-to-loopback requests fail if it is set.
  if (!isSameOrigin && !isDesktopRuntime() && !pageIsLoopback) {
    options.targetAddressSpace = isLoopback ? 'loopback' : 'local';
  }

  return fetch(url, options);
}

export function currentOriginCoreEndpoint(): string {
  if (typeof window === 'undefined') return '';
  return window.location.port === String(CORE_PORT) ? window.location.origin : '';
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function embeddedCoreEndpoint(): string {
  // Prefer the live page when it is already Core-hosted (port 8765), so the
  // browser-served UI stays same-origin. The bundled desktop webview
  // (tauri://localhost) uses localhost — macOS ATS allows that hostname from
  // WKWebView, but blocks 127.0.0.1.
  const hosted = currentOriginCoreEndpoint();
  if (hosted) return hosted;
  return `http://localhost:${CORE_PORT}`;
}

async function probeEndpoint(baseUrl: string): Promise<LocalEngineConnection> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  try {
    const response = await coreFetch(`${baseUrl}/v1/health`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Cubo core returned ${response.status}`);

    const health = (await response.json()) as {
      name?: string;
      version?: string;
      sessionToken?: string;
      transcode?: boolean;
    };
    if (health.name !== 'cubo-core' || !health.sessionToken) {
      throw new Error('Unexpected service on Cubo port');
    }

    return {
      baseUrl,
      port: new URL(baseUrl).port ? Number(new URL(baseUrl).port) : null,
      token: health.sessionToken,
      version: health.version ?? 'unknown',
      transcode: health.transcode === true,
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

export function normalizeCoreEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withProtocol);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Core address must use HTTP or HTTPS');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export async function connectCoreEndpoint(endpoint: string): Promise<LocalEngineConnection> {
  const normalized = normalizeCoreEndpoint(endpoint);
  if (!normalized) throw new Error('Enter a Cubo Core address');

  try {
    return await probeEndpoint(normalized);
  } catch {
    throw new Error(explainCoreFailure(normalized));
  }
}

/** Turns the two most common "could not reach" causes into actionable
 *  guidance: browsers silently block a secure site from calling plain-HTTP
 *  machines, and Core itself never answers HTTPS (that's tailscale serve's
 *  job, on the default port 443). */
function explainCoreFailure(endpoint: string): string {
  const url = new URL(endpoint);
  const pageIsSecure =
    typeof window !== 'undefined' && window.location.protocol === 'https:';

  if (pageIsSecure && url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return (
      `Could not reach Cubo Core at ${endpoint}. Browsers block a secure site ` +
      `from calling plain http:// addresses on other machines. Either open ` +
      `${endpoint} directly in a browser tab (Core serves this app itself), or ` +
      `give Core a secure address: run "tailscale serve --bg 8765" on the Core ` +
      `machine, then enter its https://<machine>.<tailnet>.ts.net address here.`
    );
  }

  if (url.protocol === 'https:' && url.port !== '' && url.port !== '443') {
    return (
      `Could not reach Cubo Core at ${endpoint}. Core speaks plain HTTP on ` +
      `port ${url.port}, so an https:// address on that port never answers. ` +
      `If you use "tailscale serve", enter the address without a port — ` +
      `https://${url.hostname} — it forwards to Core for you.`
    );
  }

  return `Could not reach Cubo Core at ${endpoint}`;
}

export async function discoverLocalEngine(
  configuredEndpoint = '',
): Promise<LocalEngineConnection> {
  if (configuredEndpoint) return connectCoreEndpoint(configuredEndpoint);

  for (const host of ['localhost', '127.0.0.1']) {
    try {
      return await probeEndpoint(`http://${host}:${CORE_PORT}`);
    } catch {
      // Try the other loopback form — macOS localhost often resolves to ::1.
    }
  }

  throw new Error(
    'Cubo Core was not found on this device. Open Settings to add a remote Core.',
  );
}

/** Reliable open trackers appended to every magnet. Torrentio often returns
 *  streams with no tracker list at all, leaving resolution to DHT alone —
 *  which fails on networks that block UDP or right after app launch before
 *  DHT bootstraps. These make metadata resolution work everywhere. */
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.stealth.si:80/announce',
];

export function buildMagnet(stream: Stream): string {
  const trackers = [...new Set([...stream.trackers, ...DEFAULT_TRACKERS])]
    .map((tracker) => `&tr=${encodeURIComponent(tracker)}`)
    .join('');
  return `magnet:?xt=urn:btih:${stream.infoHash}${trackers}`;
}

export async function addMagnet(
  engine: LocalEngineConnection,
  magnet: string,
  metadata?: { mediaKey?: string; title?: string },
): Promise<AddedTorrent> {
  const headers = new Headers({ 'Content-Type': 'text/plain' });
  if (metadata?.mediaKey) headers.set('X-Cubo-Media-Key', metadata.mediaKey);
  if (metadata?.title) headers.set('X-Cubo-Title', encodeURIComponent(metadata.title));
  const response = await engineFetch(engine, '/v1/torrents', {
    method: 'POST',
    headers,
    body: magnet,
  });
  if (!response.ok) {
    // rqbit's error body says WHY (metadata timeout, parse failure, …) —
    // far more useful than a bare status code.
    let detail = '';
    try {
      const body = (await response.json()) as {
        human_readable?: string;
        error?: string;
      };
      detail = body.human_readable ?? body.error ?? '';
    } catch {
      // Non-JSON body; fall back to the status code.
    }
    throw new Error(
      detail
        ? `Cubo core rejected the stream: ${detail}`
        : `Cubo core rejected the stream (${response.status})`,
    );
  }

  const data = (await response.json()) as {
    id?: number | null;
    info_hash?: string;
    details?: { info_hash?: string; files?: { name: string; length: number }[] };
  };
  return {
    id: data.id ?? null,
    infoHash: data.info_hash ?? data.details?.info_hash ?? '',
    files: data.details?.files ?? [],
  };
}

export interface TorrentProgress {
  /** Bytes verified so far, across the whole torrent. */
  downloadedBytes: number;
  totalBytes: number;
  /** Human readable download speed from the engine, when it reports one. */
  speed: string | null;
  peers: number | null;
}

type TorrentStatsRaw = {
  state?: string;
  error?: string | null;
  progress_bytes?: number;
  total_bytes?: number;
  live?: {
    download_speed?: { human_readable?: string };
    snapshot?: { peer_stats?: { live?: number } };
  } | null;
};

function toProgress(stats: TorrentStatsRaw): TorrentProgress {
  return {
    downloadedBytes: stats.progress_bytes ?? 0,
    totalBytes: stats.total_bytes ?? 0,
    speed: stats.live?.download_speed?.human_readable ?? null,
    peers: stats.live?.snapshot?.peer_stats?.live ?? null,
  };
}

export async function waitUntilLive(
  engine: LocalEngineConnection,
  idOrHash: number | string,
  {
    timeoutMs = 60_000,
    onProgress,
  }: { timeoutMs?: number; onProgress?: (progress: TorrentProgress) => void } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const id = encodeURIComponent(String(idOrHash));

  for (;;) {
    const response = await engineFetch(engine, `/v1/torrents/${id}/stats`);
    if (!response.ok) throw new Error(`Cubo core status failed (${response.status})`);
    const stats = (await response.json()) as TorrentStatsRaw;
    onProgress?.(toProgress(stats));
    if (stats.state === 'live' || stats.state === 'paused') return;
    if (stats.state === 'error') throw new Error(stats.error ?? 'The stream failed');
    if (Date.now() > deadline) throw new Error('The stream took too long to start');
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
}

export function streamUrl(
  engine: LocalEngineConnection,
  idOrHash: number | string,
  fileIndex: number,
): string {
  const id = encodeURIComponent(String(idOrHash));
  const token = encodeURIComponent(engine.token);
  return `${engine.baseUrl}/v1/torrents/${id}/stream/${fileIndex}?token=${token}`;
}

export function hlsPlaylistUrl(
  engine: LocalEngineConnection,
  idOrHash: number | string,
  fileIndex: number,
  startSeconds = 0,
): string {
  const id = encodeURIComponent(String(idOrHash));
  const token = encodeURIComponent(engine.token);
  const start = startSeconds > 0 ? `&start=${startSeconds.toFixed(3)}` : '';
  return `${engine.baseUrl}/v1/torrents/${id}/hls/${fileIndex}/media.m3u8?token=${token}${start}`;
}

/** Kicks off (and validates) the Core-side remux for one torrent file,
 *  optionally starting `startSeconds` into it (seek restart). The first
 *  playlist request blocks until ffmpeg produces playable segments, so a
 *  success here means the returned URL is immediately watchable. */
export async function startRemux(
  engine: LocalEngineConnection,
  idOrHash: number | string,
  fileIndex: number,
  startSeconds = 0,
): Promise<{ url: string; durationSeconds: number | null }> {
  const url = hlsPlaylistUrl(engine, idOrHash, fileIndex, startSeconds);
  const response = await coreFetch(url);
  if (!response.ok) {
    let detail = 'This source could not be converted for the browser.';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      // Keep the generic message for non-JSON error bodies.
    }
    throw new Error(detail);
  }
  const duration = Number(response.headers.get('X-Cubo-Duration'));
  return {
    url,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

export function largestFileIndex(files: { length: number }[]): number {
  let largest = 0;
  for (let index = 1; index < files.length; index += 1) {
    if (files[index].length > files[largest].length) largest = index;
  }
  return largest;
}

export async function getLibrary(
  engine: LocalEngineConnection,
): Promise<CoreLibrarySnapshot> {
  const response = await engineFetch(engine, '/v1/library');
  if (!response.ok) throw new Error(`Could not load the local library (${response.status})`);
  return (await response.json()) as CoreLibrarySnapshot;
}

export async function recordPlayback(
  engine: LocalEngineConnection,
  update: PlaybackUpdate,
): Promise<void> {
  const response = await engineFetch(engine, '/v1/library/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
    keepalive: true,
  });
  if (!response.ok) throw new Error(`Could not save playback progress (${response.status})`);
}

export async function setWatchLater(
  engine: LocalEngineConnection,
  item: WatchLaterItem,
  saved: boolean,
): Promise<CoreLibrarySnapshot> {
  const response = await engineFetch(engine, '/v1/library/watch-later', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item, saved }),
  });
  if (!response.ok) throw new Error(`Could not update Watch later (${response.status})`);
  return (await response.json()) as CoreLibrarySnapshot;
}

export async function removeHistoryItem(
  engine: LocalEngineConnection,
  key: string,
): Promise<CoreLibrarySnapshot> {
  const response = await engineFetch(
    engine,
    `/v1/library/history/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw new Error(`Could not remove that title (${response.status})`);
  return (await response.json()) as CoreLibrarySnapshot;
}

export async function getCacheStatus(
  engine: LocalEngineConnection,
): Promise<CacheStatus> {
  const response = await engineFetch(engine, '/v1/cache');
  if (!response.ok) throw new Error(`Could not read cache usage (${response.status})`);
  return (await response.json()) as CacheStatus;
}

export async function updateCacheLimit(
  engine: LocalEngineConnection,
  maxBytes: number,
): Promise<void> {
  const response = await engineFetch(engine, '/v1/cache/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxBytes }),
  });
  if (!response.ok) throw new Error(`Could not update the cache limit (${response.status})`);
}

export async function clearCache(engine: LocalEngineConnection): Promise<void> {
  const response = await engineFetch(engine, '/v1/cache', { method: 'DELETE' });
  if (!response.ok) throw new Error(`Could not clear the cache (${response.status})`);
}

export async function deleteCacheItem(
  engine: LocalEngineConnection,
  idOrHash: string | number,
): Promise<void> {
  const response = await engineFetch(
    engine,
    `/v1/cache/${encodeURIComponent(String(idOrHash))}`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw new Error(`Could not remove the cached video (${response.status})`);
}

function engineFetch(
  engine: LocalEngineConnection,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${engine.token}`);
  return coreFetch(`${engine.baseUrl}${path}`, { ...init, headers });
}
