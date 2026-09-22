import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { announceCacheClear, onCacheClear } from './cache-events';

test('cache clear notifications reach listeners and unsubscribe cleanly', () => {
  const previousWindow = globalThis.window;
  const previousBroadcastChannel = globalThis.BroadcastChannel;
  globalThis.window = new EventTarget() as typeof window;
  // Keep this test on the same-tab event path; BroadcastChannel is covered by
  // the browser implementation and is unavailable in some test runtimes.
  Object.defineProperty(globalThis, 'BroadcastChannel', { value: undefined, configurable: true });

  try {
    const received: string[] = [];
    const unsubscribe = onCacheClear((baseUrl) => received.push(baseUrl));
    announceCacheClear('http://127.0.0.1:8765');
    assert.deepEqual(received, ['http://127.0.0.1:8765']);
    unsubscribe();
    announceCacheClear('http://127.0.0.1:8765');
    assert.deepEqual(received, ['http://127.0.0.1:8765']);
  } finally {
    globalThis.window = previousWindow;
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      value: previousBroadcastChannel,
      configurable: true,
      writable: true,
    });
  }
});
