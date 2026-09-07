import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { addMagnet, InsufficientStorageError, startRemux, waitUntilLive } from './local-engine';

const connection = {
  baseUrl: 'http://127.0.0.1:8765', port: 8765, token: 'test', version: 'test', transcode: true,
};

test('storage errors stay distinguishable from source failures throughout startup', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return Response.json({ error: 'Free disk space before trying playback again.' }, { status: 507 });
  }) as typeof fetch;
  try {
    for (const request of [
      () => addMagnet(connection, 'magnet:test'),
      () => waitUntilLive(connection, 1),
      () => startRemux(connection, 1, 0, 2584, 1),
    ]) {
      await assert.rejects(request, (error: unknown) =>
        error instanceof InsufficientStorageError && error.message.includes('Free disk space'));
    }
    assert.equal(requests, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ordinary source failures remain eligible for fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ error: 'Source unavailable' }, { status: 502 })) as typeof fetch;
  try {
    await assert.rejects(() => addMagnet(connection, 'magnet:test'), (error: unknown) =>
      error instanceof Error && !(error instanceof InsufficientStorageError));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
