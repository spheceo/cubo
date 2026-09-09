import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodeSubtitleBytes, toWebVtt } from '../lib/subtitle-text.js';
import { requestUrl } from './_shared.js';

function sendText(res: ServerResponse, status: number, body: string, contentType = 'text/plain') {
  res.statusCode = status;
  res.setHeader('Content-Type', `${contentType}; charset=utf-8`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(body);
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const value = requestUrl(req).searchParams.get('url');
  if (!value) return sendText(res, 400, 'Missing subtitle URL');

  let source: URL;
  try {
    source = new URL(value);
  } catch {
    return sendText(res, 400, 'Invalid subtitle URL');
  }

  if (source.protocol !== 'https:' || !source.hostname.endsWith('.strem.io')) {
    return sendText(res, 400, 'Unsupported subtitle host');
  }

  try {
    const upstream = await fetch(source);
    if (!upstream.ok) return sendText(res, upstream.status, 'Subtitle unavailable');
    const subtitle = decodeSubtitleBytes(new Uint8Array(await upstream.arrayBuffer()));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.end(toWebVtt(subtitle));
  } catch {
    sendText(res, 502, 'Subtitle unavailable');
  }
}
