#!/usr/bin/env bun
/**
 * Throttling HTTP forward proxy for the playback benchmarks.
 *
 * Every byte between client and server passes through one shared token
 * bucket per direction (default 10 Mbit/s each, 64 KB burst), so concurrent
 * requests compete for the link and queue like a saturated 10 Mbps Ethernet
 * port would. Absolute-form requests (`GET http://host:port/path`) are
 * forwarded over keep-alive upstream connections; CONNECT tunnels are
 * supported too.
 *
 *   bun scripts/bench/throttle-proxy.ts [--mbps 10] [--down-mbps N] [--up-mbps N]
 *                                       [--burst-kb 64] [--host 127.0.0.1] [--port 8791]
 *                                       [--deny googleapis.com,google.com,gstatic.com]
 *
 * --deny refuses (403) requests and tunnels to those domains and their
 * subdomains: headless Chrome otherwise pulls tens of MB of background
 * downloads (optimization-guide models) through the throttled link
 * mid-run. Pass --deny '' to forward everything.
 *
 * Direct (non-proxied) requests to the proxy itself:
 *   GET  /__stats  -> {bytesDown, bytesUp, byTarget: {"host:port": {bytesDown, bytesUp}},
 *                      downMbps, upMbps, startedAt, resetAt}
 *   POST /__reset  -> zeroes the counters
 *
 * Chrome: --proxy-server=http://127.0.0.1:8791 --proxy-bypass-list="<-loopback>"
 * reqwest: Proxy::all("http://127.0.0.1:8791") (also used for loopback URLs as
 * long as NO_PROXY does not list them).
 */
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] != null) return process.argv[index + 1]!;
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

const mbps = Number(flag('mbps', '10'));
const downMbps = Number(flag('down-mbps', String(mbps)));
const upMbps = Number(flag('up-mbps', String(mbps)));
const burstBytes = Number(flag('burst-kb', '64')) * 1024;
const host = flag('host', '127.0.0.1');
const port = Number(flag('port', '8791'));
const deny = flag('deny', 'googleapis.com,google.com,gstatic.com')
  .split(',')
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean);
const denied = (hostname: string) => {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return deny.some((domain) => name === domain || name.endsWith(`.${domain}`));
};
let refused: Record<string, number> = {};

/** Largest slice that waits for tokens at once: keeps streams interleaved. */
const PIECE = 16 * 1024;

/** FIFO token bucket shared by every connection in one direction. */
class TokenBucket {
  private tokens: number;
  private last = performance.now();
  private queue: { bytes: number; resolve: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly bytesPerSecond: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  private refill() {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.bytesPerSecond);
    this.last = now;
  }

  take(bytes: number): Promise<void> {
    if (!(this.bytesPerSecond > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      this.queue.push({ bytes: Math.min(bytes, this.burst), resolve });
      this.pump();
    });
  }

  private pump() {
    if (this.timer) return;
    this.refill();
    while (this.queue.length > 0 && this.tokens >= this.queue[0]!.bytes) {
      const next = this.queue.shift()!;
      this.tokens -= next.bytes;
      next.resolve();
    }
    if (this.queue.length > 0) {
      const wait = ((this.queue[0]!.bytes - this.tokens) / this.bytesPerSecond) * 1000;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, Math.max(1, Math.ceil(wait)));
    }
  }
}

const down = new TokenBucket((downMbps * 1e6) / 8, burstBytes);
const up = new TokenBucket((upMbps * 1e6) / 8, burstBytes);

type Counter = { bytesDown: number; bytesUp: number };
const startedAt = Date.now();
let resetAt = startedAt;
let totals: Counter = { bytesDown: 0, bytesUp: 0 };
let byTarget: Record<string, Counter> = {};

function count(target: string, direction: 'down' | 'up', bytes: number) {
  const entry = (byTarget[target] ??= { bytesDown: 0, bytesUp: 0 });
  if (direction === 'down') {
    totals.bytesDown += bytes;
    entry.bytesDown += bytes;
  } else {
    totals.bytesUp += bytes;
    entry.bytesUp += bytes;
  }
}

interface Sink {
  write(chunk: Uint8Array): boolean;
  once(event: 'drain', listener: () => void): unknown;
  destroyed?: boolean;
}

/** Copies `source` into `sink` at the bucket's pace. Resolves when the source
 *  ends or either side goes away. */
async function throttledCopy(
  source: AsyncIterable<Uint8Array>,
  sink: Sink,
  bucket: TokenBucket,
  target: string,
  direction: 'down' | 'up',
  closed: () => boolean,
) {
  for await (const chunk of source) {
    for (let offset = 0; offset < chunk.length; offset += PIECE) {
      const piece = chunk.subarray(offset, Math.min(chunk.length, offset + PIECE));
      await bucket.take(piece.length);
      if (closed() || sink.destroyed) return;
      count(target, direction, piece.length);
      if (!sink.write(piece)) await once(sink as unknown as NodeJS.EventEmitter, 'drain');
    }
  }
}

const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function headBytes(headers: http.IncomingHttpHeaders | http.OutgoingHttpHeaders, firstLine: string) {
  let bytes = firstLine.length + 4;
  for (const [name, value] of Object.entries(headers)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) bytes += name.length + 4 + String(v ?? '').length;
  }
  return bytes;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const raw = req.url ?? '/';
  // Origin-form: a request to the proxy itself.
  if (raw.startsWith('/')) {
    const path = raw.split('?')[0];
    if (path === '/__stats' && req.method === 'GET') {
      return json(res, 200, { ...totals, byTarget, refused, downMbps, upMbps, startedAt, resetAt });
    }
    if (path === '/__reset' && req.method === 'POST') {
      totals = { bytesDown: 0, bytesUp: 0 };
      byTarget = {};
      refused = {};
      resetAt = Date.now();
      return json(res, 200, { ok: true, resetAt });
    }
    return json(res, 404, { error: 'not a proxy request' });
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return json(res, 400, { error: 'bad request target' });
  }
  if (url.protocol !== 'http:') return json(res, 400, { error: 'only http:// is proxied (use CONNECT)' });
  const target = `${url.hostname}:${url.port || '80'}`;
  if (denied(url.hostname)) {
    refused[target] = (refused[target] ?? 0) + 1;
    return json(res, 403, { error: 'denied by throttle-proxy --deny' });
  }

  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value != null) headers[name] = value;
  }
  headers.host = url.host;

  let closed = false;
  const upstream = http.request({
    agent,
    hostname: url.hostname,
    port: Number(url.port || 80),
    method: req.method,
    path: `${url.pathname}${url.search}`,
    headers,
  });
  const abort = () => {
    if (closed) return;
    closed = true;
    upstream.destroy();
  };
  res.on('close', () => {
    if (!res.writableFinished) abort();
  });

  upstream.on('error', (error) => {
    if (closed) return;
    closed = true;
    if (!res.headersSent) json(res, 502, { error: `upstream: ${error.message}` });
    else res.destroy();
  });

  upstream.on('response', async (upstreamRes) => {
    try {
      const out: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase()) && value != null) out[name] = value;
      }
      const head = headBytes(out, `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? ''}`);
      await down.take(head);
      if (closed) return;
      count(target, 'down', head);
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, out);
      res.flushHeaders?.();
      await throttledCopy(upstreamRes, res, down, target, 'down', () => closed);
      if (!closed) res.end();
    } catch {
      abort();
      res.destroy();
    }
  });

  try {
    const head = headBytes(req.headers, `${req.method} ${raw} HTTP/1.1`);
    await up.take(head);
    count(target, 'up', head);
    await throttledCopy(req, upstream, up, target, 'up', () => closed);
    if (!closed) upstream.end();
  } catch {
    abort();
  }
});

server.on('connect', async (req: http.IncomingMessage, client: net.Socket, headBuffer: Buffer) => {
  const [hostname, portText] = (req.url ?? '').split(':');
  const target = `${hostname}:${portText || '443'}`;
  if (denied(hostname ?? '')) {
    refused[target] = (refused[target] ?? 0) + 1;
    client.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
    return;
  }
  const remote = net.connect(Number(portText || 443), hostname!);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    remote.destroy();
    client.destroy();
  };
  remote.on('error', close);
  client.on('error', close);
  remote.on('close', close);
  client.on('close', close);
  remote.on('connect', async () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (headBuffer.length > 0) {
      await up.take(headBuffer.length);
      count(target, 'up', headBuffer.length);
      remote.write(headBuffer);
    }
    void throttledCopy(remote, client, down, target, 'down', () => closed).catch(close).then(close);
    void throttledCopy(client, remote, up, target, 'up', () => closed).catch(close).then(close);
  });
});

server.keepAliveTimeout = 60_000;
server.headersTimeout = 65_000;
server.requestTimeout = 0;
server.listen(port, host, () => {
  console.log(
    `throttle-proxy on http://${host}:${port}  down ${downMbps} Mbit/s, up ${upMbps} Mbit/s, burst ${burstBytes / 1024} KB, deny [${deny.join(', ')}]`,
  );
});
