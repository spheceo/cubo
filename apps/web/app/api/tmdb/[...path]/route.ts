import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'TMDB_API_KEY not configured' },
      { status: 500 },
    );
  }

  const { path } = await context.params;
  const searchParams = new URLSearchParams(request.nextUrl.search);
  searchParams.set('api_key', apiKey);
  const search = `?${searchParams.toString()}`;
  const url = `https://api.themoviedb.org/3/${path.join('/')}${search}`;

  try {
    const upstream = await fetch(url, { next: { revalidate: 3600 } });
    const data: unknown = await upstream.json();
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'TMDB upstream error' }, { status: 502 });
  }
}
