import type { IncomingMessage, ServerResponse } from 'node:http';
import { proxyPath, requestUrl, sendJson } from './_shared.js';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const { path, params } = proxyPath(requestUrl(req));
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
