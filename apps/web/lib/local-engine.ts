import type {
  CacheEntry,
  CoreLibrarySnapshot,
  MediaType,
  Stream,
  SubtitleReleaseHint,
  WatchLaterItem,
} from '@cubo/core';
import { delayUnthrottled } from '@/lib/background-playback';
import { announceCacheClear } from './cache-events';

export const CORE_PORT = 8765;
const DISCOVERY_TIMEOUT_MS = 4_000;
const DEVICE_TOKEN_PREFIX = 'cubo.deviceToken:';

/** A reachable Core on another machine that has not been paired with this
 *  browser yet. The UI catches this and asks for a pairing code (shown by
 *  `cubo pair` on the machine running Core). */
export class PairingRequiredError extends Error {
  endpoint: string;

  constructor(endpoint: string) {
    super(
      'That Cubo Core is on another machine. Enter a pairing code from it to connect.',
    );
    this.name = 'PairingRequiredError';
    this.endpoint = endpoint;
  }
}

function savedDeviceToken(baseUrl: string): string | null {
  return window.localStorage.getItem(DEVICE_TOKEN_PREFIX + baseUrl);
}

/** Cheap authorized call to confirm a remembered device token still works
 *  (Core forgets nothing, but the user may have deleted paired-devices). */
async function tokenWorks(baseUrl: string, token: string): Promise<boolean> {
  try {
    const response = await coreFetch(`${baseUrl}/v1/library`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Exchanges a pairing code for a device token, remembers it for this Core
 *  address, and returns a live connection. */
export async function pairWithCore(
  endpoint: string,
  code: string,
): Promise<LocalEngineConnection> {
  const baseUrl = normalizeCoreEndpoint(endpoint);
  const response = await coreFetch(`${baseUrl}/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.trim(), deviceName: describeThisDevice() }),
  });
  if (!response.ok) {
    throw new Error(await readEngineError(response, 'That code did not work'));
  }
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new Error('Cubo Core sent an unexpected pairing reply');
  window.localStorage.setItem(DEVICE_TOKEN_PREFIX + baseUrl, body.token);
  return probeEndpoint(baseUrl);
}

function describeThisDevice(): string {
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    '';
  return platform ? `${platform} browser` : 'Web browser';
}

export interface LocalEngineConnection {
  baseUrl: string;
  port: number | null;
  token: string;
  version: string;
  /** True when this Core has ffmpeg and can remux MKV/incompatible-audio sources. */
  transcode: boolean;
  /** True when Core runs playback sessions (`/v1/sessions`): full-length
   *  playlists and Core-owned playback state. Older Cores lack it. */
  sessions?: boolean;
  /** Origin of the Vite/dev UI this Core was started for, when known. */
  webUrl?: string | null;
}

export interface AddedTorrent {
  id: number | null;
  infoHash: string;
  files: { name: string; length: number; included?: boolean }[];
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
  progressUpdatedAt?: number;
  progressDeviceId?: string;
  watchedDeltaSeconds: number;
  sessionStarted: boolean;
  watchHref: string;
  detailHref: string;
}

export interface CacheStatus {
  usedBytes: number;
  maxBytes: number;
  directory: string;
  itemCount: number;
  entries: CacheEntry[];
  diskFreeBytes?: number;
  diskReserveBytes?: number;
  diskPressure?: boolean;
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
  // network. Loopback-to-loopback requests fail if it is set.
  if (!isSameOrigin && !pageIsLoopback) {
    options.targetAddressSpace = isLoopback ? 'loopback' : 'local';
  }

  return fetch(url, options);
}

export function currentOriginCoreEndpoint(): string {
  if (typeof window === 'undefined') return '';
  // Vite (:4200) and the marketing site (:4300) are separate processes.
  // Core-hosted pages — preferred :8765 or a fallback like :8766 — use this origin.
  if (window.location.port === '4200' || window.location.port === '4300') return '';
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
    return '';
  }
  return window.location.origin;
}

async function probeEndpoint(
  baseUrl: string,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<LocalEngineConnection> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

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
      sessions?: boolean;
      pairingRequired?: boolean;
      webUrl?: string | null;
    };
    if (health.name !== 'cubo-core') {
      throw new Error('Unexpected service on Cubo port');
    }

    // Core only hands its session token to same-machine callers. From a
    // remote device we use the device token from a previous pairing, or ask
    // the user to pair.
    let token = health.sessionToken ?? null;
    if (!token) {
      const remembered = savedDeviceToken(baseUrl);
      if (remembered && (await tokenWorks(baseUrl, remembered))) {
        token = remembered;
      } else {
        if (remembered) window.localStorage.removeItem(DEVICE_TOKEN_PREFIX + baseUrl);
        throw new PairingRequiredError(baseUrl);
      }
    }

    return {
      baseUrl,
      port: new URL(baseUrl).port ? Number(new URL(baseUrl).port) : null,
      token,
      version: health.version ?? 'unknown',
      transcode: health.transcode === true,
      sessions: health.sessions === true,
      webUrl: typeof health.webUrl === 'string' && health.webUrl ? health.webUrl : null,
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
  } catch (reason) {
    // A pairing prompt is an answer, not a connection failure.
    if (reason instanceof PairingRequiredError) throw reason;
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

/** `just dev` binds the next free port when persist already owns :8765. */
const DEV_CORE_PORTS = [CORE_PORT, CORE_PORT + 1, CORE_PORT + 2];

function isLoopbackName(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** True when this Core's advertised UI is the page the user is on.
 *  `127.0.0.1:4200` and `localhost:4200` count as the same Vite app. */
export function coreServesPage(
  webUrl: string | null | undefined,
  page: { hostname: string; port: string },
): boolean {
  if (!webUrl) return false;
  try {
    const advertised = new URL(webUrl);
    if (advertised.port !== page.port) return false;
    if (advertised.hostname === page.hostname) return true;
    return isLoopbackName(advertised.hostname) && isLoopbackName(page.hostname);
  } catch {
    return false;
  }
}

export function pickDiscoveredCore<T extends { webUrl?: string | null }>(
  found: T[],
  page: { hostname: string; port: string } | null,
): T | undefined {
  if (found.length === 0) return undefined;
  if (!page) return found[0];
  return found.find((core) => coreServesPage(core.webUrl, page)) ?? found[0];
}

export async function discoverLocalEngine(
  configuredEndpoint = '',
): Promise<LocalEngineConnection> {
  if (configuredEndpoint) return connectCoreEndpoint(configuredEndpoint);

  // The page and Core almost always share a host — dev server on :4200,
  // Core on :8765 of the same machine. Probe the page's own hostname first
  // so http://kenobi:4200 finds http://kenobi:8765 (works for Tailscale
  // names, bare LAN names, and raw IPs alike), then fall back to loopback.
  const hosts: string[] = [];
  if (typeof window !== 'undefined' && window.location.hostname) {
    hosts.push(window.location.hostname);
  }
  for (const host of ['localhost', '127.0.0.1']) {
    if (!hosts.includes(host)) hosts.push(host);
  }

  const onVite =
    typeof window !== 'undefined' && window.location.port === '4200';
  const ports = onVite ? DEV_CORE_PORTS : [CORE_PORT];
  const found: LocalEngineConnection[] = [];
  let pairing: PairingRequiredError | null = null;

  for (const host of hosts) {
    // IPv6 literals (::1) need brackets in a URL authority.
    const authority = host.includes(':') ? `[${host}]` : host;
    await Promise.all(
      ports.map(async (port, index) => {
        try {
          found.push(
            await probeEndpoint(
              `http://${authority}:${port}`,
              index === 0 ? DISCOVERY_TIMEOUT_MS : 800,
            ),
          );
        } catch (reason) {
          if (reason instanceof PairingRequiredError) pairing = reason;
        }
      }),
    );
    if (found.length > 0) break;
  }

  if (found.length === 0 && pairing) throw pairing;

  found.sort((a, b) => (a.port ?? 0) - (b.port ?? 0));
  const chosen = pickDiscoveredCore(
    found,
    typeof window !== 'undefined'
      ? { hostname: window.location.hostname, port: window.location.port }
      : null,
  );
  if (!chosen) {
    throw new Error(
      'Cubo Core was not found on this device. Open Settings to add a remote Core.',
    );
  }
  return chosen;
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

/** Local storage pressure affects every source; trying another torrent cannot fix it. */
export class InsufficientStorageError extends Error {}

export async function addMagnet(
  engine: LocalEngineConnection,
  magnet: string,
  metadata?: { mediaKey?: string; title?: string; fileIndex?: number | null },
): Promise<AddedTorrent> {
  const headers = new Headers({ 'Content-Type': 'text/plain' });
  if (metadata?.mediaKey) headers.set('X-Cubo-Media-Key', metadata.mediaKey);
  if (metadata?.title) headers.set('X-Cubo-Title', encodeURIComponent(metadata.title));
  if (metadata?.fileIndex != null && Number.isFinite(metadata.fileIndex)) {
    headers.set('X-Cubo-File-Index', String(metadata.fileIndex));
  }
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
    const ErrorType = response.status === 507 ? InsufficientStorageError : Error;
    throw new ErrorType(
      detail
        ? `Cubo core rejected the stream: ${detail}`
        : `Cubo core rejected the stream (${response.status})`,
    );
  }

  const data = (await response.json()) as {
    id?: number | null;
    info_hash?: string;
    details?: {
      info_hash?: string;
      files?: { name: string; length: number; included?: boolean }[];
    };
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
    timeoutMs = 90_000,
    onProgress,
    signal,
  }: {
    timeoutMs?: number;
    onProgress?: (progress: TorrentProgress) => void;
    /** Stops the polling loop the moment the caller navigates away or
     *  switches sources — otherwise an abandoned start keeps hitting Core
     *  twice a second for up to a minute. */
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const id = encodeURIComponent(String(idOrHash));

  for (;;) {
    signal?.throwIfAborted();
    const response = await engineFetch(engine, `/v1/torrents/${id}/stats`, { signal });
    if (response.status === 507) {
      throw new InsufficientStorageError(
        await readEngineError(response, 'Free disk space before trying playback again.'),
      );
    }
    if (!response.ok) throw new Error(`Cubo core status failed (${response.status})`);
    const stats = (await response.json()) as TorrentStatsRaw;
    onProgress?.(toProgress(stats));
    // `paused` is not ready — the cache maintainer pauses background
    // torrents, and treating that as success sent remux/ffprobe at a
    // torrent that would never fetch more pieces.
    if (stats.state === 'live') return;
    if (stats.state === 'error') throw new Error(stats.error ?? 'The stream failed');
    if (Date.now() > deadline) throw new Error('The stream took too long to start');
    await delayUnthrottled(500, signal);
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

/** Release-matching data for external subtitles (OpenSubtitles hash, exact
 *  size and filename), computed by Core through rqbit's ranged stream — the
 *  tail chunk may be pulled from peers on demand. Null when Core cannot
 *  produce it; subtitle lookup then falls back to title-ID matching. */
export async function getSubtitleMatch(
  engine: LocalEngineConnection,
  idOrHash: number | string,
  fileIndex: number,
): Promise<SubtitleReleaseHint | null> {
  try {
    const id = encodeURIComponent(String(idOrHash));
    const response = await engineFetch(
      engine,
      `/v1/torrents/${id}/files/${fileIndex}/subtitle-match`,
    );
    if (!response.ok) return null;
    const match = (await response.json()) as {
      videoHash?: string;
      videoSize?: number;
      filename?: string;
    };
    if (!match.videoHash || !match.videoSize) return null;
    return {
      videoHash: match.videoHash,
      videoSize: match.videoSize,
      filename: match.filename ?? undefined,
    };
  } catch {
    return null;
  }
}

export interface SkipSegmentWindow {
  /** Absolute seconds into the media where the segment starts. */
  start: number;
  /** Absolute end, or null when the segment runs to the end of the file. */
  end: number | null;
  /** Where the timing came from: container chapters or a crowdsourced API. */
  source?: string;
}

/** One declared section of the media — a container chapter or a
 *  crowd-sourced window — for the dev timeline overlay. */
export interface SkipSection {
  start: number;
  end: number | null;
  /** intro | credits | recap | preview | postcredits | chapter */
  kind: string;
  label: string;
  source?: string;
}

export interface SkipSegments {
  intro: SkipSegmentWindow | null;
  credits: SkipSegmentWindow | null;
  /** Every section Core could classify — powers the dev timeline bands. */
  sections: SkipSection[];
}

/** Intro/credits windows for the playing file. Core reads named container
 *  chapters first, then falls back to TheIntroDB/IntroDB. Returns null when
 *  nothing is known (or the running Core predates the endpoint) — callers
 *  should simply hide skip UI rather than treat it as an error. */
export async function getSkipSegments(
  engine: LocalEngineConnection,
  query: {
    torrent: string;
    file: number;
    type: MediaType;
    tmdbId?: number;
    imdbId?: string | null;
    season?: number;
    episode?: number;
  },
  signal?: AbortSignal,
): Promise<SkipSegments | null> {
  try {
    const params = new URLSearchParams({
      torrent: query.torrent,
      file: String(query.file),
      type: query.type,
    });
    if (query.tmdbId) params.set('tmdb', String(query.tmdbId));
    if (query.imdbId) params.set('imdb', query.imdbId);
    if (query.season) params.set('season', String(query.season));
    if (query.episode) params.set('episode', String(query.episode));
    const response = await engineFetch(
      engine,
      `/v1/skip-segments?${params}`,
      { signal },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      intro?: { start?: number; end?: number | null; source?: string } | null;
      credits?: { start?: number; end?: number | null; source?: string } | null;
      sections?: {
        start?: number;
        end?: number | null;
        kind?: string;
        label?: string;
        source?: string;
      }[];
    };
    const window = (
      segment: { start?: number; end?: number | null; source?: string } | null | undefined,
    ): SkipSegmentWindow | null => {
      const start = segment?.start;
      if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) {
        return null;
      }
      const end = segment?.end;
      return {
        start,
        end:
          typeof end === 'number' && Number.isFinite(end) && end > start
            ? end
            : null,
        source: segment?.source,
      };
    };
    const sections = (body.sections ?? []).flatMap((section): SkipSection[] => {
      const start = section.start;
      const kind = section.kind;
      if (
        typeof start !== 'number' ||
        !Number.isFinite(start) ||
        start < 0 ||
        typeof kind !== 'string'
      ) {
        return [];
      }
      const end = section.end;
      return [
        {
          start,
          end:
            typeof end === 'number' && Number.isFinite(end) && end > start
              ? end
              : null,
          kind,
          label: section.label || kind,
          source: section.source,
        },
      ];
    });
    return { intro: window(body.intro), credits: window(body.credits), sections };
  } catch {
    return null;
  }
}

export function hlsPlaylistUrl(
  engine: LocalEngineConnection,
  idOrHash: number | string,
  fileIndex: number,
  startSeconds = 0,
  generation?: number,
): string {
  const id = encodeURIComponent(String(idOrHash));
  const token = encodeURIComponent(engine.token);
  const start = startSeconds > 0 ? `&start=${startSeconds.toFixed(3)}` : '';
  const gen = generation && generation > 0 ? `&gen=${generation}` : '';
  return `${engine.baseUrl}/v1/torrents/${id}/hls/${fileIndex}/media.m3u8?token=${token}${start}${gen}`;
}

/** Kicks off (and validates) the Core-side remux for one torrent file,
 *  optionally starting `startSeconds` into it (seek restart). The first
 *  playlist request blocks until ffmpeg produces playable segments, so a
 *  success here means the returned URL is immediately watchable.
 *
 *  Returns `startSeconds`: where the playlist ACTUALLY begins in the source.
 *  ffmpeg's input seek lands on the keyframe at/before the requested spot,
 *  so this can be a few seconds earlier — callers must use it (never the
 *  request) as their absolute-time offset, or subtitles and reported
 *  positions drift after every seek restart. */
export async function startRemux(
  engine: LocalEngineConnection,
  idOrHash: number | string,
  fileIndex: number,
  startSeconds = 0,
  generation?: number,
): Promise<{ url: string; durationSeconds: number | null; startSeconds: number }> {
  const url = hlsPlaylistUrl(engine, idOrHash, fileIndex, startSeconds, generation);
  const response = await coreFetch(url);
  if (!response.ok) {
    let detail = 'This source could not be converted for the browser.';
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      // Keep the generic message for non-JSON error bodies.
    }
    const ErrorType = response.status === 507 ? InsufficientStorageError : Error;
    throw new ErrorType(detail);
  }
  const duration = Number(response.headers.get('X-Cubo-Duration'));
  const actualStart = Number(response.headers.get('X-Cubo-Start'));
  const landed =
    Number.isFinite(actualStart) && actualStart >= 0 ? actualStart : startSeconds;
  // A leftover poll of an older playlist URL used to restart ffmpeg at the
  // beginning while this request asked for minutes in. Adopting that header
  // as the absolute origin puts the playhead at ~0 while the picture is
  // hours later — refuse it so the caller can retry or keep the last job.
  if (startSeconds > 60 && landed < 1) {
    throw new Error('The converter restarted at the beginning instead of the requested time.');
  }
  return {
    url,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    // Older Cores don't send the header; assume the seek landed exactly.
    startSeconds: landed,
  };
}

export type SessionPhase = 'resolving' | 'probing' | 'ready' | 'failed' | 'closed';

export interface PlaybackSessionStatus {
  id: string;
  phase: SessionPhase;
  error?: { code: string; message: string };
  mode?: 'direct' | 'hls';
  durationSeconds?: number;
  torrentId?: number;
  infoHash?: string;
  fileIndex?: number;
  fileName?: string;
  torrent?: {
    progressBytes: number;
    totalBytes: number;
    downloadMbps: number;
    peers: number;
    finished: boolean;
  };
  remux?: {
    segmentsReady: number;
    starvedSeconds?: number | null;
    restarts: number;
  };
  timeline: {
    resolvedMs?: number;
    initializedMs?: number;
    probedMs?: number;
    readyMs?: number;
    firstMediaMs?: number;
  };
}

/** A session Core no longer knows — it restarted, or the session expired.
 *  The source itself is fine; the caller recreates the session. */
export class SessionGoneError extends Error {}

/** A source Core gave up on (no peers, unsupported codec, stalled swarm). */
export class SessionFailedError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Starts a Core-owned playback session for one source. Returns at once;
 *  poll `waitForSession` until it is ready. */
export async function createSession(
  engine: LocalEngineConnection,
  request: {
    magnet: string;
    mediaKey?: string;
    title?: string;
    fileIndex?: number | null;
    resumeSeconds?: number;
    hevc: boolean;
  },
): Promise<PlaybackSessionStatus> {
  const response = await engineFetch(engine, '/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const message = await readEngineError(response, 'Cubo Core could not open the stream');
    if (response.status === 507) throw new InsufficientStorageError(message);
    throw new Error(message);
  }
  return (await response.json()) as PlaybackSessionStatus;
}

/** Asks Core to warm a source the viewer is likely to open next (metadata,
 *  file header, probe) without downloading the whole file. Best-effort and
 *  fire-and-forget: older Cores without the route just 404. */
export function prefetchSource(
  engine: LocalEngineConnection,
  request: {
    magnet: string;
    mediaKey?: string;
    title?: string;
    fileIndex?: number | null;
    hevc: boolean;
  },
): void {
  if (!engine.sessions) return;
  void engineFetch(engine, '/v1/prefetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  }).catch(() => undefined);
}

export async function getSession(
  engine: LocalEngineConnection,
  id: string,
  signal?: AbortSignal,
): Promise<PlaybackSessionStatus> {
  const response = await engineFetch(engine, `/v1/sessions/${encodeURIComponent(id)}`, { signal });
  if (response.status === 404) throw new SessionGoneError('The playback session ended.');
  if (!response.ok) throw new Error(await readEngineError(response, 'Session status failed'));
  return (await response.json()) as PlaybackSessionStatus;
}

/** Polls until the session can play. Rejects with `SessionFailedError` when
 *  Core gives up on the source. */
export async function waitForSession(
  engine: LocalEngineConnection,
  id: string,
  {
    signal,
    onStatus,
  }: { signal?: AbortSignal; onStatus?: (status: PlaybackSessionStatus) => void } = {},
): Promise<PlaybackSessionStatus> {
  for (;;) {
    signal?.throwIfAborted();
    const status = await getSession(engine, id, signal);
    onStatus?.(status);
    if (status.phase === 'ready') return status;
    if (status.phase === 'failed' || status.phase === 'closed') {
      const message = status.error?.message ?? 'The stream failed';
      if (status.error?.code === 'disk_full') throw new InsufficientStorageError(message);
      throw new SessionFailedError(status.error?.code ?? 'failed', message);
    }
    await delayUnthrottled(250, signal);
  }
}

/** Tells Core where the viewer is. Drives how far ahead Core converts and
 *  keeps the session alive while paused. Returns the stretches of the movie
 *  already on disk (absolute seconds), or null from Cores that don't say. */
export async function heartbeatSession(
  engine: LocalEngineConnection,
  id: string,
  positionSeconds: number,
  playing: boolean,
): Promise<{ start: number; end: number }[] | null> {
  const response = await engineFetch(engine, `/v1/sessions/${encodeURIComponent(id)}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positionSeconds, playing }),
  });
  if (response.status === 404) throw new SessionGoneError('The playback session ended.');
  if (response.status !== 200) return null;
  const body = (await response.json().catch(() => null)) as { availableRanges?: unknown } | null;
  if (!Array.isArray(body?.availableRanges)) return null;
  return body.availableRanges
    .filter(
      (range): range is [number, number] =>
        Array.isArray(range) && Number.isFinite(range[0]) && Number.isFinite(range[1]),
    )
    .map(([start, end]) => ({ start, end }));
}

export function closeSession(engine: LocalEngineConnection, id: string): void {
  void engineFetch(engine, `/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
    () => undefined,
  );
}

/** For `navigator.sendBeacon` on page unload (no custom headers there). */
export function sessionCloseBeaconUrl(engine: LocalEngineConnection, id: string): string {
  return `${engine.baseUrl}/v1/sessions/${encodeURIComponent(id)}/close?token=${encodeURIComponent(engine.token)}`;
}

export function sessionMediaUrl(
  engine: LocalEngineConnection,
  status: PlaybackSessionStatus,
): string {
  const id = encodeURIComponent(status.id);
  const token = encodeURIComponent(engine.token);
  return status.mode === 'hls'
    ? `${engine.baseUrl}/v1/sessions/${id}/hls/media.m3u8?token=${token}`
    : `${engine.baseUrl}/v1/sessions/${id}/stream?token=${token}`;
}

/** Index of the file Cubo should play. When rqbit marked a subset
 *  `included` (season-pack `only_files`), pick among those so a 26 GB pack
 *  does not resolve to a different episode's file. */
export function largestFileIndex(
  files: { length: number; included?: boolean }[],
): number {
  const preferIncluded = files.some((file) => file.included === true);
  let largest = -1;
  for (let index = 0; index < files.length; index += 1) {
    if (preferIncluded && files[index].included !== true) continue;
    if (largest < 0 || files[index].length > files[largest].length) {
      largest = index;
    }
  }
  return largest < 0 ? 0 : largest;
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

export interface SystemStats {
  storage: { totalBytes: number; freeBytes: number };
  memory: { totalBytes: number; usedBytes: number; freeBytes: number };
  cpu: { usagePercent: number; coreCount: number; brand: string };
  gpu: { adapters: string[]; usagePercent: number[] };
  uptimeSeconds: number;
}

export interface FolderInfo {
  name: string;
  path: string;
  hasFolders: boolean;
  hasFiles: boolean;
}

export interface FolderListing {
  path: string;
  folders: FolderInfo[];
}

export async function listFolders(
  engine: LocalEngineConnection,
  path?: string,
): Promise<FolderListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const response = await engineFetch(engine, `/v1/folders${query}`);
  if (!response.ok) throw new Error(await readEngineError(response, 'Could not list folders'));
  return (await response.json()) as FolderListing;
}

export async function createFolder(
  engine: LocalEngineConnection,
  parent: string,
  name: string,
): Promise<FolderInfo> {
  const response = await engineFetch(engine, '/v1/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent, name }),
  });
  if (!response.ok) throw new Error(await readEngineError(response, 'Could not create that folder'));
  return (await response.json()) as FolderInfo;
}

export async function getSystemStats(
  engine: LocalEngineConnection,
): Promise<SystemStats> {
  const response = await engineFetch(engine, '/v1/system');
  if (!response.ok) throw new Error(`Could not read system stats (${response.status})`);
  return (await response.json()) as SystemStats;
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

export async function updateCacheDirectory(
  engine: LocalEngineConnection,
  directory: string,
): Promise<void> {
  const response = await engineFetch(engine, '/v1/cache/directory', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory }),
  });
  if (!response.ok) {
    throw new Error(await readEngineError(response, 'Could not change the cache folder'));
  }
}

async function readEngineError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // The body is not JSON; the status text is enough.
  }
  return `${fallback} (${response.status})`;
}

export async function clearCache(engine: LocalEngineConnection): Promise<void> {
  announceCacheClear(engine.baseUrl);
  const response = await engineFetch(engine, '/v1/cache', { method: 'DELETE' });
  if (!response.ok) throw new Error(await readEngineError(response, 'Could not clear the cache'));
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
  if (!response.ok) throw new Error(await readEngineError(response, 'Could not remove the cached video'));
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

export type UpdatePhase = 'idle' | 'downloading' | 'ready' | 'applying';

export interface CoreUpdateStatus {
  current: string;
  latest: string | null;
  state: UpdatePhase;
  error?: string | null;
  /** 0–1 while Core is streaming the release. Absent on older Cores. */
  progress?: number | null;
}

export async function getUpdateStatus(
  engine: LocalEngineConnection,
): Promise<CoreUpdateStatus> {
  const response = await engineFetch(engine, '/v1/update');
  if (!response.ok) throw new Error(await readEngineError(response, 'Could not check for updates'));
  return (await response.json()) as CoreUpdateStatus;
}

export async function downloadUpdate(
  engine: LocalEngineConnection,
): Promise<CoreUpdateStatus> {
  const response = await engineFetch(engine, '/v1/update', { method: 'POST' });
  if (!response.ok) throw new Error(await readEngineError(response, 'Could not download the update'));
  return (await response.json()) as CoreUpdateStatus;
}

export async function applyUpdate(
  engine: LocalEngineConnection,
): Promise<CoreUpdateStatus> {
  const response = await engineFetch(engine, '/v1/update/apply', { method: 'POST' });
  if (!response.ok) throw new Error(await readEngineError(response, 'Could not install the update'));
  return (await response.json()) as CoreUpdateStatus;
}

export type ClientLogLevel = 'info' | 'warn' | 'error';

/** Ships a diagnostic event to Core's structured log (same cubo.log the
 *  engine writes), so one file tells the whole session's story: which stream
 *  was picked and why, fallback switches, seek restarts, failures. Fire and
 *  forget — logging must never delay or break playback. */
export function shipClientLog(
  engine: LocalEngineConnection,
  level: ClientLogLevel,
  event: string,
  data?: Record<string, unknown>,
): void {
  void engineFetch(engine, '/v1/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, event, data }),
  }).catch(() => undefined);
}
