import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  coreServesPage,
  createSession,
  InsufficientStorageError,
  pickDiscoveredCore,
  waitForSession,
} from './local-engine';

const connection = {
  baseUrl: 'http://127.0.0.1:8765', port: 8765, token: 'test', version: 'test', transcode: true, sessions: true,
};

test('storage errors stay distinguishable from source failures throughout startup', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (_url, init) => {
    requests += 1;
    return init?.method === 'POST'
      ? Response.json({ error: 'Free disk space before trying playback again.' }, { status: 507 })
      : Response.json({ id: 'test', phase: 'failed', error: { code: 'disk_full', message: 'Free disk space before trying playback again.' } });
  }) as typeof fetch;
  try {
    for (const request of [
      () => createSession(connection, { magnet: 'magnet:test', hevc: false }),
      () => waitForSession(connection, 'test'),
    ]) {
      await assert.rejects(request, (error: unknown) =>
        error instanceof InsufficientStorageError && error.message.includes('Free disk space'));
    }
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Vite on localhost prefers the just-dev Core that advertised :4200', () => {
  const persist = { baseUrl: 'http://127.0.0.1:8765', webUrl: null };
  const justDev = { baseUrl: 'http://127.0.0.1:8766', webUrl: 'http://127.0.0.1:4200' };
  assert.equal(
    pickDiscoveredCore([persist, justDev], { hostname: 'localhost', port: '4200' }),
    justDev,
  );
  assert.equal(pickDiscoveredCore([persist], { hostname: 'localhost', port: '4200' }), persist);
  assert.equal(coreServesPage('http://127.0.0.1:4200', { hostname: 'localhost', port: '4200' }), true);
  assert.equal(coreServesPage('http://127.0.0.1:4200', { hostname: 'localhost', port: '4300' }), false);
});

test('ordinary source failures remain eligible for fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ error: 'Source unavailable' }, { status: 502 })) as typeof fetch;
  try {
    await assert.rejects(() => createSession(connection, { magnet: 'magnet:test', hevc: false }), (error: unknown) =>
      error instanceof Error && !(error instanceof InsufficientStorageError));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
