#!/usr/bin/env bun
/**
 * Browser-path playback benchmark: headless Chrome plays the Traitors S02E10
 * test episode from a benchmark Core, with every page request (loopback
 * included) going through throttle-proxy.ts.
 *
 *   bun scripts/bench/browser-run.ts --label browser-after [--wall 300] [--start 2500]
 *        [--core http://127.0.0.1:8764] [--proxy http://127.0.0.1:8791]
 *        [--out <dir>] [--core-version 0.0.42] [--headful]
 *
 * Needs: throttle-proxy.ts on :8791, serve-web.ts on :4200, a benchmark Core
 * on :8764 (see README.md). Writes <out>/<label>.json (shared schema with the
 * native player) and <out>/<label>.extra.json (diagnostics).
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadavg } from 'node:os';

const BENCH_DIR =
  process.env.BENCH_DIR ??
  '/private/tmp/claude-501/-Users-siphesihlembuyisa-Documents-code-cubo/c9835802-cc92-4cde-9634-eb4bf9197f51/scratchpad/bench';

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] != null && !process.argv[index + 1]!.startsWith('--')) {
    return process.argv[index + 1];
  }
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const label = flag('label') ?? (console.error('--label is required'), process.exit(2));
const wallSeconds = Number(flag('wall', '300'));
const startPosition = Number(flag('start', '2500'));
const coreUrl = flag('core', 'http://127.0.0.1:8764')!;
const proxyUrl = flag('proxy', 'http://127.0.0.1:8791')!;
const outDir = flag('out', join(BENCH_DIR, 'results'))!;
const chromePath = flag('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')!;
const headful = has('headful');

// The test episode (see README.md).
const MEDIA_ID = 291431;
const SEASON = 2;
const EPISODE = 10;
const ITEM_KEY = `tv:${MEDIA_ID}:${SEASON}:${EPISODE}`;
const INFO_HASH = '83b1ef08bdbacfb458121c677a63c95d788d250a';
const FILE_NAME = 'The.Celebrity.Traitors.S02E10.Finale.1080p.HDTV.H264-DARKFLiX[EZTVx.to].mkv';
const FILE_BYTES = 2886258924;
const DURATION = 4650;
const WATCH_PATH = `/watch/tv/${MEDIA_ID}?season=${SEASON}&episode=${EPISODE}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- CDP client

class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, ((params: any) => void)[]>();
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id != null) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!waiter) return;
        if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiter.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', () => reject(new Error(`CDP connect failed: ${url}`)));
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method: string, listener: (params: any) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  close() {
    this.ws.close();
  }
}

// ------------------------------------------------------------------ helpers

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${response.status}`);
  return (await response.json()) as T;
}

type ProxyStats = { bytesDown: number; bytesUp: number; downMbps: number; byTarget: Record<string, { bytesDown: number; bytesUp: number }> };

/** Cumulative CPU seconds per pid, from `ps` (user + system). */
function processTable(): Map<number, { ppid: number; cpu: number; comm: string }> {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,comm='], { encoding: 'utf8', maxBuffer: 16 << 20 });
  const table = new Map<number, { ppid: number; cpu: number; comm: string }>();
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const parts = match[3]!.replace(/^\d+-/, '').split(':').map(Number);
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + part;
    table.set(Number(match[1]), { ppid: Number(match[2]), cpu: seconds, comm: match[4]! });
  }
  return table;
}

function treeOf(root: number, table: ReturnType<typeof processTable>): number[] {
  const pids = [root];
  for (let i = 0; i < pids.length; i++) {
    for (const [pid, info] of table) if (info.ppid === pids[i] && !pids.includes(pid)) pids.push(pid);
  }
  return pids.filter((pid) => table.has(pid));
}

/** CPU% (of one core) of a process tree between two samples. Processes that
 *  appeared since the last sample count from zero. */
class CpuMeter {
  private last = new Map<number, number>();
  private lastAt = 0;
  sample(pids: number[], table: ReturnType<typeof processTable>, now: number): number | null {
    let used = 0;
    const next = new Map<number, number>();
    for (const pid of pids) {
      const cpu = table.get(pid)!.cpu;
      next.set(pid, cpu);
      used += cpu - (this.last.get(pid) ?? 0);
    }
    const elapsed = (now - this.lastAt) / 1000;
    const first = this.lastAt === 0;
    this.last = next;
    this.lastAt = now;
    if (first || elapsed <= 0) return null;
    return Math.max(0, (used / elapsed) * 100);
  }
}

function corePid(): number {
  const out = execFileSync('lsof', ['-nP', '-t', `-iTCP:${new URL(coreUrl).port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const pid = Number(out.trim().split('\n')[0]);
  if (!pid) throw new Error('no Core listening');
  return pid;
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const avg = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

// ------------------------------------------------------- page instrumentation

const stream = {
  name: 'Torrentio\n1080p',
  title: `${FILE_NAME}\n👤 20 💾 2.69 GB ⚙️ EZTV`,
  filename: FILE_NAME,
  infoHash: INFO_HASH,
  fileIdx: 0,
  quality: '1080p',
  sizeBytes: FILE_BYTES,
  seeders: 20,
  trackers: [],
};

/** Runs before the app on every document. Seeds the remembered source and
 *  resume point (so the app plays this file at `startPosition` without asking
 *  Torrentio), then watches the <video> element. A stall is time spent not
 *  advancing while not paused / seeking after playback first advanced (the
 *  app's own `playback_stall` uses `waiting` → `playing`, 250 ms minimum). */
function pageScript(seed: Record<string, string>, origin: string) {
  if (location.origin !== origin) return;
  try {
    if (!localStorage.getItem('cubo.bench.seeded')) {
      for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
      localStorage.setItem('cubo.bench.seeded', '1');
    }
  } catch {}
  const now = () => performance.timeOrigin + performance.now();
  const B: any = ((window as any).__bench = {
    events: [] as any[],
    stalls: [] as any[],
    current: null as null | { start: number; at: number; waiting: boolean },
    firstPlayingAt: null as number | null,
    firstAdvanceAt: null as number | null,
    firstAdvancePosition: null as number | null,
    lastCT: null as number | null,
    lastAdvanceAt: 0,
    played: 0,
    waiting: false,
    seeks: 0,
    pausedSince: null as number | null,
    externalPauses: [] as any[],
  });
  const types = ['loadstart', 'loadedmetadata', 'canplay', 'play', 'playing', 'waiting', 'pause', 'seeking', 'seeked', 'stalled', 'error', 'ended', 'emptied'];
  for (const type of types) {
    document.addEventListener(
      type,
      (event) => {
        const video = event.target;
        if (!(video instanceof HTMLVideoElement)) return;
        const t = now();
        B.events.push({ type, t, ct: video.currentTime, rs: video.readyState });
        if (B.events.length > 4000) B.events.splice(0, 1000);
        if (type === 'waiting') B.waiting = true;
        if (type === 'playing') {
          B.waiting = false;
          B.firstPlayingAt ??= t;
        }
        if (type === 'seeking') B.seeks += 1;
      },
      true,
    );
  }
  const endStall = (t: number) => {
    const stall = B.current;
    B.current = null;
    if (stall && t - stall.start >= 250) B.stalls.push({ start: stall.start, end: t, at: stall.at, waiting: stall.waiting });
  };
  setInterval(() => {
    const video = document.querySelector('video');
    if (!video) return;
    const t = now();
    const ct = video.currentTime;
    const last = B.lastCT;
    B.lastCT = ct;
    if (last == null) return;
    const delta = ct - last;
    const advancing = delta > 0.005 && !video.seeking;
    if (advancing && delta < 3) B.played += delta;
    if (B.firstAdvanceAt == null) {
      if (advancing && !video.paused) {
        B.firstAdvanceAt = t;
        B.firstAdvancePosition = ct;
        B.lastAdvanceAt = t;
      }
      return;
    }
    if (advancing) {
      B.lastAdvanceAt = t;
      endStall(t);
      return;
    }
    if (video.paused && !video.ended) {
      // Nobody pauses during a run. A pause here came from outside the page
      // (macOS Now Playing / media keys reach headless Chrome too): note it
      // and resume, so it neither ends the run early nor counts as a stall.
      B.pausedSince ??= t;
      if (t - B.pausedSince > 1000) {
        B.externalPauses.push({ t: B.pausedSince, ms: t - B.pausedSince, ct });
        B.pausedSince = null;
        void video.play().catch(() => {});
      }
    } else {
      B.pausedSince = null;
    }
    if (video.paused || video.ended || video.seeking) {
      // A pause or seek is not a stall (matches the app's diagnostics).
      B.current = null;
      return;
    }
    if (!B.current && (B.waiting || t - B.lastAdvanceAt >= 500)) {
      B.current = { start: B.lastAdvanceAt, at: ct, waiting: B.waiting };
    }
    if (B.current && B.waiting) B.current.waiting = true;
  }, 100);
  (window as any).__benchSnapshot = () => {
    const video = document.querySelector('video');
    let ahead = 0;
    const ranges: [number, number][] = [];
    if (video) {
      for (let i = 0; i < video.buffered.length; i++) {
        const start = video.buffered.start(i);
        const end = video.buffered.end(i);
        ranges.push([start, end]);
        if (start <= video.currentTime + 0.25 && end > video.currentTime) ahead = end - video.currentTime;
      }
    }
    return {
      t: now(),
      hasVideo: !!video,
      currentTime: video?.currentTime ?? null,
      paused: video?.paused ?? null,
      readyState: video?.readyState ?? null,
      ended: video?.ended ?? null,
      error: video?.error ? { code: video.error.code, message: video.error.message } : null,
      bufferAhead: ahead,
      buffered: ranges,
      stalled: !!B.current,
      currentStall: B.current,
      stalls: B.stalls,
      firstPlayingAt: B.firstPlayingAt,
      firstAdvanceAt: B.firstAdvanceAt,
      firstAdvancePosition: B.firstAdvancePosition,
      played: B.played,
      seeks: B.seeks,
      externalPauses: B.externalPauses,
      events: B.events.slice(-400),
      overlay: document.body?.innerText?.slice(0, 200) ?? '',
    };
  };
}

// --------------------------------------------------------------------- main

async function main() {
  const loadStart = loadavg().map((v) => round(v, 2));
  if (loadStart[0]! > 4) console.warn(`warning: 1-min load average is ${loadStart[0]}; results will be noisy`);
  const health = await getJson<{ version: string; sessionToken?: string; name: string }>(`${coreUrl}/v1/health`);
  if (health.name !== 'cubo-core' || !health.sessionToken) throw new Error('benchmark Core not reachable');
  const coreVersion = flag('core-version', health.version)!;
  const stats0 = await getJson<ProxyStats>(`${proxyUrl}/__stats`);
  await fetch('http://127.0.0.1:4200/').catch(() => {
    throw new Error('web app is not served on :4200 (run serve-web.ts)');
  });
  const token = health.sessionToken;
  const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  // Seed Core's resume point too (the app reads both and keeps the newer).
  const seededAt = Date.now();
  await fetch(`${coreUrl}/v1/library/progress`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      key: ITEM_KEY,
      mediaId: MEDIA_ID,
      mediaType: 'tv',
      imdbId: null,
      title: 'The Celebrity Traitors',
      subtitle: `S${SEASON} E${EPISODE}`,
      posterPath: null,
      backdropPath: null,
      season: SEASON,
      episode: EPISODE,
      positionSeconds: startPosition,
      durationSeconds: DURATION,
      watchedDeltaSeconds: 0,
      progressUpdatedAt: seededAt - 1000,
      progressDeviceId: 'bench',
      sessionStarted: false,
      watchHref: WATCH_PATH,
      detailHref: `/tv/${MEDIA_ID}`,
    }),
  }).then((response) => {
    if (!response.ok) throw new Error(`seeding progress failed: ${response.status}`);
  });

  const seed = {
    'cubo.sources.v1': JSON.stringify({ [ITEM_KEY]: stream }),
    'cubo.show-sources.v1': JSON.stringify({ [String(MEDIA_ID)]: stream }),
    'cubo.playhead': JSON.stringify({
      [ITEM_KEY]: { positionSeconds: startPosition, durationSeconds: DURATION, updatedAt: seededAt, infoHash: INFO_HASH },
    }),
  };

  // Fresh profile per run: no HTTP cache, no remembered decode failures.
  const profile = join(BENCH_DIR, 'chrome', `${label}-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const chromeArgs = [
    ...(headful ? [] : ['--headless=new']),
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    `--proxy-server=${proxyUrl}`,
    '--proxy-bypass-list=<-loopback>',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationHints,MediaRouter,Translate,HardwareMediaKeyHandling,GlobalMediaControls',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1920,1080',
    'about:blank',
  ];
  const chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeLog = '';
  chrome.stderr!.on('data', (chunk) => {
    if (chromeLog.length < 200_000) chromeLog += String(chunk);
  });
  const killChrome = () => {
    try {
      chrome.kill('SIGTERM');
    } catch {}
  };
  process.on('SIGINT', () => {
    killChrome();
    process.exit(130);
  });

  try {
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      const file = join(profile, 'DevToolsActivePort');
      if (existsSync(file)) port = Number(readFileSync(file, 'utf8').split('\n')[0]);
    }
    if (!port) throw new Error(`Chrome did not open DevTools; stderr:\n${chromeLog.slice(-2000)}`);
    let pageWs = '';
    for (let i = 0; i < 50 && !pageWs; i++) {
      const targets = await getJson<{ type: string; webSocketDebuggerUrl: string }[]>(`http://127.0.0.1:${port}/json/list`).catch(() => []);
      pageWs = targets.find((target) => target.type === 'page')?.webSocketDebuggerUrl ?? '';
      if (!pageWs) await sleep(100);
    }
    if (!pageWs) throw new Error('no page target');
    const cdp = await Cdp.connect(pageWs);

    // Network: find the session POST, time HLS segments, keep Torrentio out
    // (the seeded source must be the only one: nothing else touches a swarm).
    type Req = { url: string; method: string; start: number; bytes?: number; end?: number; status?: number; failed?: string };
    const requests = new Map<string, Req>();
    let sessionPostAt: number | null = null;
    let sessionPostId: string | null = null;
    let sessionId: string | null = null;
    cdp.on('Network.requestWillBeSent', (p) => {
      const req: Req = { url: p.request.url, method: p.request.method, start: p.wallTime * 1000 };
      requests.set(p.requestId, req);
      if (req.method === 'POST' && /\/v1\/sessions(\?|$)/.test(new URL(req.url).pathname + '?') && sessionPostAt == null) {
        sessionPostAt = req.start;
        sessionPostId = p.requestId;
      }
    });
    cdp.on('Network.responseReceived', (p) => {
      const req = requests.get(p.requestId);
      if (req) req.status = p.response.status;
    });
    let monoToWall: number | null = null;
    cdp.on('Network.loadingFinished', async (p) => {
      const req = requests.get(p.requestId);
      if (!req) return;
      req.bytes = p.encodedDataLength;
      req.end = monoToWall != null ? p.timestamp * 1000 + monoToWall : Date.now();
      if (p.requestId === sessionPostId && !sessionId) {
        try {
          const body = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
          sessionId = JSON.parse(body.body).id ?? null;
        } catch {}
      }
    });
    cdp.on('Network.loadingFailed', (p) => {
      const req = requests.get(p.requestId);
      if (req) req.failed = p.errorText;
    });
    // requestWillBeSent carries both clocks: map CDP monotonic time to wall.
    cdp.on('Network.requestWillBeSent', (p) => {
      monoToWall ??= p.wallTime * 1000 - p.timestamp * 1000;
    });
    const consoleErrors: string[] = [];
    cdp.on('Runtime.exceptionThrown', (p) => consoleErrors.push(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).slice(0, 300)));
    const mediaProps: Record<string, unknown> = {};
    const mediaErrors: unknown[] = [];
    cdp.on('Media.playerPropertiesChanged', (p) => {
      for (const prop of p.properties) mediaProps[prop.name] = prop.value;
    });
    cdp.on('Media.playerErrorsRaised', (p) => mediaErrors.push(...p.errors));

    // Small buffers: DevTools must not hold segment bodies in memory.
    await cdp.send('Network.enable', { maxTotalBufferSize: 4 << 20, maxResourceBufferSize: 256 << 10 });
    await cdp.send('Network.setBlockedURLs', { urls: ['*/api/torrentio/*'] });
    await cdp.send('Runtime.enable');
    await cdp.send('Media.enable').catch(() => {});
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    const origin = new URL(coreUrl).origin;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(${pageScript.toString()})(${JSON.stringify(seed)}, ${JSON.stringify(origin)});`,
    });

    await fetch(`${proxyUrl}/__reset`, { method: 'POST' });
    const navigatedAt = Date.now();
    await cdp.send('Page.navigate', { url: `${origin}${WATCH_PATH}` });
    console.log(`[${label}] navigated to ${origin}${WATCH_PATH} via ${proxyUrl} (Core ${coreVersion})`);

    const snapshot = async () => {
      const result = await cdp.send('Runtime.evaluate', {
        expression: 'window.__benchSnapshot ? window.__benchSnapshot() : null',
        returnByValue: true,
      });
      return result.result?.value ?? null;
    };

    const pid = corePid();
    const coreCpu = new CpuMeter();
    const clientCpu = new CpuMeter();
    const vtCpu = new CpuMeter();
    let lastStats = { at: Date.now(), bytesDown: 0 };
    const timeline: any[] = [];
    const videoSamples: any[] = [];
    let latest: any = null;
    let tickIndex = 0;

    const deadline = () =>
      sessionPostAt != null ? sessionPostAt + wallSeconds * 1000 : navigatedAt + 60_000 + wallSeconds * 1000;
    // Prime the CPU meters.
    {
      const table = processTable();
      const now = Date.now();
      coreCpu.sample(treeOf(pid, table), table, now);
      clientCpu.sample(treeOf(chrome.pid!, table), table, now);
      vtCpu.sample([...table].filter(([, i]) => /VTDecoderXPCService|VTEncoderXPCService/.test(i.comm)).map(([p]) => p), table, now);
    }

    // Ticks on a fixed 500 ms grid (the work per tick must not stretch it).
    const loopStart = Date.now();
    while (Date.now() < deadline()) {
      tickIndex += 1;
      await sleep(Math.max(0, loopStart + tickIndex * 500 - Date.now()));
      latest = (await snapshot().catch(() => null)) ?? latest;
      if (latest) {
        videoSamples.push({
          t: round((latest.t - navigatedAt) / 1000, 3),
          position: latest.currentTime,
          paused: latest.paused,
          readyState: latest.readyState,
          buffer_ahead_s: round(latest.bufferAhead, 2),
          buffered: latest.buffered,
          stalled: latest.stalled,
        });
      }
      if (tickIndex % 2 !== 0) continue;

      // 1 s sample: link rate, CPU, Core's view of the session.
      const now = Date.now();
      const stats = await getJson<ProxyStats>(`${proxyUrl}/__stats`).catch(() => null);
      const table = processTable();
      const core = coreCpu.sample(treeOf(pid, table), table, now) ?? 0;
      const client = clientCpu.sample(treeOf(chrome.pid!, table), table, now) ?? 0;
      const vt = vtCpu.sample([...table].filter(([, i]) => /VTDecoderXPCService|VTEncoderXPCService/.test(i.comm)).map(([p]) => p), table, now) ?? 0;
      let linkMbps = 0;
      if (stats) {
        linkMbps = ((stats.bytesDown - lastStats.bytesDown) * 8) / 1e6 / ((now - lastStats.at) / 1000);
        lastStats = { at: now, bytesDown: stats.bytesDown };
      }
      let coreSession: any = null;
      if (sessionId) {
        coreSession = await getJson<any>(`${coreUrl}/v1/sessions/${sessionId}`, { headers: auth }).catch(() => null);
      }
      if (sessionPostAt == null) continue;
      const ffmpegCount = treeOf(pid, table).filter((p) => /ffmpeg/.test(table.get(p)!.comm)).length;
      timeline.push({
        t: round((now - sessionPostAt) / 1000, 2),
        position: round(latest?.currentTime ?? 0, 2),
        buffer_ahead_s: round(latest?.bufferAhead ?? 0, 2),
        link_mbps: round(linkMbps, 2),
        core_cpu: round(core, 1),
        client_cpu: round(client, 1),
        stalled: !!latest?.stalled,
        // diagnostics, stripped from the shared-schema result below
        _vt_cpu: round(vt, 1),
        _ffmpeg: ffmpegCount,
        _core_ready_ahead_s: coreSession?.remux?.readyAheadSeconds ?? null,
        _core_paused_ahead: coreSession?.remux?.pausedAhead ?? null,
        _core_phase: coreSession?.phase ?? null,
      });
      const last = timeline[timeline.length - 1];
      if (timeline.length % 10 === 0) {
        console.log(
          `[${label}] t=${last.t}s pos=${last.position} ahead=${last.buffer_ahead_s}s link=${last.link_mbps}Mbps core=${last.core_cpu}% chrome=${last.client_cpu}% stalls=${latest?.stalls?.length ?? 0}${last.stalled ? ' STALLED' : ''} coreAhead=${last._core_ready_ahead_s}`,
        );
      }
    }

    const end = Date.now();
    const final = (await snapshot().catch(() => null)) ?? latest;
    const finalStats = await getJson<ProxyStats>(`${proxyUrl}/__stats`);
    // Leave the page so the app closes its session (pagehide beacon).
    await cdp.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
    await sleep(1500);
    cdp.close();

    if (sessionPostAt == null) throw new Error('the page never created a playback session');
    const t0 = sessionPostAt as number;
    const stalls = [...(final?.stalls ?? [])];
    if (final?.currentStall && end - final.currentStall.start >= 250) {
      stalls.push({ ...final.currentStall, end, open: true });
    }
    const result = {
      label,
      client: 'browser' as const,
      core_version: coreVersion,
      link_mbps: stats0.downMbps,
      wall_seconds: round((end - t0) / 1000, 2),
      start_position: startPosition,
      startup_ms: final?.firstAdvanceAt != null ? Math.round(final.firstAdvanceAt - t0) : -1,
      stall_count: stalls.length,
      stall_ms_total: Math.round(stalls.reduce((sum: number, s: any) => sum + (s.end - s.start), 0)),
      stalls: stalls.map((s: any) => ({
        at_position: round(s.at, 2),
        started_at_s: round((s.start - t0) / 1000, 2),
        ms: Math.round(s.end - s.start),
      })),
      played_seconds: round(final?.played ?? 0, 2),
      bytes_down: finalStats.bytesDown,
      core_cpu_avg: round(avg(timeline.map((s) => s.core_cpu)), 1),
      client_cpu_avg: round(avg(timeline.map((s) => s.client_cpu)), 1),
      timeline: timeline.map(({ t, position, buffer_ahead_s, link_mbps, core_cpu, client_cpu, stalled }) => ({
        t,
        position,
        buffer_ahead_s,
        link_mbps,
        core_cpu,
        client_cpu,
        stalled,
      })),
    };

    const all = [...requests.values()];
    const segments = all
      .filter((r) => /\/hls\/(?!.*\.m3u8)/.test(r.url))
      .map((r) => ({
        file: new URL(r.url).pathname.split('/').pop(),
        started_at_s: round((r.start - t0) / 1000, 2),
        ms: r.end != null ? Math.round(r.end - r.start) : null,
        bytes: r.bytes ?? null,
        status: r.status ?? null,
        failed: r.failed ?? null,
      }));
    const done = segments.filter((s) => s.bytes && s.ms);
    const extra = {
      label,
      load_average_start: loadStart,
      load_average_end: loadavg().map((v) => round(v, 2)),
      core_url: coreUrl,
      proxy_url: proxyUrl,
      session_id: sessionId,
      nav_to_session_ms: Math.round(t0 - navigatedAt),
      nav_to_first_frame_ms: final?.firstAdvanceAt != null ? Math.round(final.firstAdvanceAt - navigatedAt) : null,
      first_playing_event_ms: final?.firstPlayingAt != null ? Math.round(final.firstPlayingAt - t0) : null,
      first_advance_position: final?.firstAdvancePosition ?? null,
      final_position: final?.currentTime ?? null,
      seeks: final?.seeks ?? null,
      external_pauses: (final?.externalPauses ?? []).map((p: any) => ({
        started_at_s: round((p.t - t0) / 1000, 2),
        ms: Math.round(p.ms),
        position: round(p.ct, 2),
      })),
      video_events_tail: (final?.events ?? []).map((ev: any) => ({ ...ev, t: round((ev.t - t0) / 1000, 3) })),
      bytes_up: finalStats.bytesUp,
      proxy_by_target: finalStats.byTarget,
      proxy_refused: (finalStats as any).refused ?? null,
      vt_service_cpu_avg: round(avg(timeline.map((s) => s._vt_cpu)), 1),
      media_player_properties: mediaProps,
      media_errors: mediaErrors,
      console_exceptions: consoleErrors.slice(0, 50),
      segments_fetched: segments.length,
      segment_avg_bytes: done.length ? Math.round(avg(done.map((s) => s.bytes!))) : null,
      segment_avg_ms: done.length ? Math.round(avg(done.map((s) => s.ms!))) : null,
      segments,
      stalls_detail: stalls.map((s: any) => ({
        at_position: round(s.at, 2),
        started_at_s: round((s.start - t0) / 1000, 2),
        ms: Math.round(s.end - s.start),
        waiting_event: !!s.waiting,
        open_at_end: !!s.open,
      })),
      timeline_diagnostics: timeline.map((s) => ({
        t: s.t,
        vt_cpu: s._vt_cpu,
        ffmpeg: s._ffmpeg,
        core_ready_ahead_s: s._core_ready_ahead_s,
        core_paused_ahead: s._core_paused_ahead,
        core_phase: s._core_phase,
      })),
      video_samples: videoSamples,
      chrome_args: chromeArgs,
    };
    writeFileSync(join(outDir, `${label}.json`), JSON.stringify(result, null, 2));
    writeFileSync(join(outDir, `${label}.extra.json`), JSON.stringify(extra, null, 2));
    console.log(
      `[${label}] startup_ms=${result.startup_ms} stalls=${result.stall_count} stall_ms=${result.stall_ms_total} played=${result.played_seconds}s bytes_down=${result.bytes_down} core_cpu=${result.core_cpu_avg}% client_cpu=${result.client_cpu_avg}%`,
    );
    console.log(
      `[${label}] decoder=${mediaProps.kVideoDecoderName ?? '?'} platform=${mediaProps.kIsPlatformVideoDecoder ?? '?'} external_pauses=${extra.external_pauses.length} load=${extra.load_average_start[0]}->${extra.load_average_end[0]}`,
    );
    console.log(`wrote ${join(outDir, `${label}.json`)}`);
  } finally {
    killChrome();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
