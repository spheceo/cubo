import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const search = request.nextUrl.search;
  const url = `https://torrentio.strem.fun/${path.join('/')}${search}`;

  try {
    const upstream = await fetch(url, { next: { revalidate: 300 } });
    const data: unknown = await upstream.json();
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json(
      { error: 'Torrentio upstream error' },
      { status: 502 },
    );
  }
}
