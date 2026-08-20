import type { IncomingMessage, ServerResponse } from 'node:http';

export function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost');
}

/** Multi-segment API paths arrive as the ?path= query param — see the rewrites
 *  in vercel.json. (Vercel's [...catchall] function routes only match a single
 *  path segment, so nested paths like /api/tmdb/trending/movie/week 404.) */
export function proxyPath(url: URL): { path: string; params: URLSearchParams } {
  const path = url.searchParams.get('path') ?? '';
  url.searchParams.delete('path');
  return { path, params: url.searchParams };
}

// The desktop app's webview (tauri://localhost) calls these routes
// cross-origin. GETs are simple requests, so ACAO on the response is
// sufficient — no preflight handling needed.
export function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
  cacheSeconds?: number,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (cacheSeconds) {
    res.setHeader(
      'Cache-Control',
      `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`,
    );
  }
  res.end(JSON.stringify(data));
}
