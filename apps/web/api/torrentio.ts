import type { IncomingMessage, ServerResponse } from 'node:http';
import { proxyPath, requestUrl, sendJson } from './_shared.js';

/** Stream lookups for one title — the only request shape Cubo makes. Keeps
 *  the route from being freeloaded as a general proxy to the upstream. */
const ALLOWED_PATH = /^stream\/(movie|series)\/tt\d+(:\d+:\d+)?\.json$/;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { path, params } = proxyPath(requestUrl(req));
  if (!ALLOWED_PATH.test(path)) {
    return sendJson(res, 404, { error: 'Unknown stream endpoint' });
  }
  const search = params.toString();

  try {
    const upstream = await fetch(
      `https://torrentio.strem.fun/${path}${search ? `?${search}` : ''}`,
    );
    const data: unknown = await upstream.json();
    sendJson(res, upstream.status, data, 300);
  } catch {
    sendJson(res, 502, { error: 'Torrentio upstream error' });
  }
}
