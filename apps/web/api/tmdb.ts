import type { IncomingMessage, ServerResponse } from 'node:http';
import { proxyPath, requestUrl, sendJson } from './_shared.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';

/** Only the request shapes Cubo itself makes. Without this, anyone on the
 *  internet could use this route as a free proxy for the ENTIRE TMDB API on
 *  our key, burning its quota. Extend the list when the app grows a new
 *  endpoint. */
const ALLOWED_PATHS = [
  /^trending\/(movie|tv)\/(day|week)$/,
  /^(movie|tv)\/\d+$/,
  /^(movie|tv)\/(now_playing|on_the_air|popular|top_rated)$/,
  /^tv\/\d+\/season\/\d+$/,
  /^search\/(movie|tv|multi)$/,
];

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, { error: 'TMDB_API_KEY not configured' });
  }

  const { path, params } = proxyPath(requestUrl(req));
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
    return sendJson(res, 404, { error: 'Unknown catalog endpoint' });
  }
  params.set('api_key', apiKey);

  try {
    const upstream = await fetch(`${TMDB_BASE}/${path}?${params.toString()}`);
    const data: unknown = await upstream.json();
    sendJson(res, upstream.status, data, 3600);
  } catch {
    sendJson(res, 502, { error: 'TMDB upstream error' });
  }
}
