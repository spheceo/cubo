import type { IncomingMessage, ServerResponse } from 'node:http';
import { proxyPath, requestUrl, sendJson } from './_shared.js';

/** Subtitle lookups for one title — the only request shape Cubo makes. */
const ALLOWED_PATH = /^subtitles\/(movie|series)\/tt\d+(:\d+:\d+)?(\/[\w=.-]+)?\.json$/;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { path, params } = proxyPath(requestUrl(req));
  if (!ALLOWED_PATH.test(path)) {
    return sendJson(res, 404, { error: 'Unknown subtitle endpoint' });
  }
  const search = params.toString();

  try {
    const upstream = await fetch(
      `https://opensubtitles-v3.strem.io/${path}${search ? `?${search}` : ''}`,
    );
    const data: unknown = await upstream.json();
    sendJson(res, upstream.status, data, 21_600);
  } catch {
    sendJson(res, 502, { error: 'Subtitle service unavailable' });
  }
}
