import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createClient } from '@cubo/core';

test('Cinemeta keeps movie/TV IDs separate and reuses title metadata for seasons', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const movie = { id: 'tt1000001', moviedb_id: 42, name: 'Movie' };
  const show = {
    id: 'tt2000002', moviedb_id: 42, name: 'Show',
    videos: [{ season: 1, episode: 1, name: 'Pilot' }],
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/catalog/movie/')) return Response.json({ metas: [movie] });
    if (url.includes('/catalog/series/')) return Response.json({ metas: [show] });
    if (url.endsWith('/meta/movie/tt1000001.json')) return Response.json({ meta: movie });
    if (url.endsWith('/meta/series/tt2000002.json')) return Response.json({ meta: show });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  try {
    const client = createClient({ metadataProvider: 'cinemeta' });
    await client.tmdb.trending('movie');
    await client.tmdb.trending('tv');
    assert.equal((await client.tmdb.details('movie', 42)).title, 'Movie');
    assert.equal((await client.tmdb.details('tv', 42)).title, 'Show');
    const beforeSeason = requests.length;
    assert.equal((await client.tmdb.season(42, 1))[0]?.name, 'Pilot');
    assert.equal(requests.length, beforeSeason);

    // An uncached TV route must warm the TV catalog, never the movie one.
    requests.length = 0;
    const coldClient = createClient({ metadataProvider: 'cinemeta' });
    assert.equal((await coldClient.tmdb.details('tv', 42)).title, 'Show');
    assert.equal(requests.length, 2);
    assert.ok(requests[0]?.includes('/catalog/series/'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
