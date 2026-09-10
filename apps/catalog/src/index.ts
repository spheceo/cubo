const TMDB_BASE = 'https://api.themoviedb.org/3';

/** Same shapes the Cubo app asks for. Anything else 404s so this Worker is
 *  not a general TMDB proxy. */
const ALLOWED_PATHS = [
  /^trending\/(movie|tv)\/(day|week)$/,
  /^(movie|tv)\/\d+$/,
  /^(movie|tv)\/(now_playing|on_the_air|popular|top_rated)$/,
  /^tv\/\d+\/season\/\d+$/,
  /^search\/(movie|tv|multi)$/,
];

export interface Env {
  TMDB_API_KEY: string;
  LIMIT: RateLimit;
}

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }
    if (request.method !== 'GET') {
      return json(405, { error: 'GET only' });
    }

    const ip = request.headers.get('cf-connecting-ip') ?? 'anon';
    const { success } = await env.LIMIT.limit({ key: ip });
    if (!success) {
      return json(429, { error: 'Too many catalog requests' });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
      return json(404, { error: 'Unknown catalog endpoint' });
    }

    const key = env.TMDB_API_KEY;
    if (!key) {
      return json(500, { error: 'TMDB_API_KEY not configured' });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) {
      return withCors(cached);
    }

    const params = new URLSearchParams(url.search);
    params.set('api_key', key);
    const upstream = await fetch(`${TMDB_BASE}/${path}?${params}`);
    const body = await upstream.text();
    const response = new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': upstream.ok
          ? 'public, s-maxage=3600, stale-while-revalidate=7200'
          : 'no-store',
        ...cors(),
      },
    });
    if (upstream.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  },
};

function cors(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors() },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors())) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}
