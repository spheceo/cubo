import type { IncomingMessage, ServerResponse } from 'node:http';
import { proxyPath, requestUrl, sendJson } from './_shared.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, { error: 'TMDB_API_KEY not configured' });
  }

  const { path, params } = proxyPath(requestUrl(req));
  params.set('api_key', apiKey);

  try {
    const upstream = await fetch(`${TMDB_BASE}/${path}?${params.toString()}`);
    const data: unknown = await upstream.json();
    sendJson(res, upstream.status, data, 3600);
  } catch {
    sendJson(res, 502, { error: 'TMDB upstream error' });
  }
}
