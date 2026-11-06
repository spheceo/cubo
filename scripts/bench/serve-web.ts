#!/usr/bin/env bun
/**
 * Serves a built web app (`vite build` output) on 127.0.0.1:4200, the origin a
 * debug (benchmark) Core proxies its UI from. Pages are then opened at the
 * Core's own origin (http://127.0.0.1:8764/...), so the page talks to that Core
 * only, exactly like the installed Core serving its embedded dist.
 *
 *   bun scripts/bench/serve-web.ts <dist-dir> [--port 4200]
 */
import { join, normalize } from 'node:path';

const dist = process.argv[2];
if (!dist) {
  console.error('usage: bun scripts/bench/serve-web.ts <dist-dir> [--port 4200]');
  process.exit(2);
}
const portIndex = process.argv.indexOf('--port');
const port = portIndex > 0 ? Number(process.argv[portIndex + 1]) : 4200;

Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const path = normalize(decodeURIComponent(new URL(request.url).pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = Bun.file(join(dist, path));
    if (path !== '/' && (await file.exists())) {
      const immutable = path.startsWith('/assets/');
      return new Response(file, {
        headers: { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
      });
    }
    // Missing assets are 404s; every other path is the SPA shell.
    if (/\.[a-z0-9]+$/i.test(path)) return new Response('not found', { status: 404 });
    return new Response(Bun.file(join(dist, 'index.html')), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    });
  },
});
console.log(`serving ${dist} on http://127.0.0.1:${port}`);
