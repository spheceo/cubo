import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Stream } from '@cubo/core';
import { loadStreams, saveStreams } from './stream-cache';

const stream = (infoHash: string): Stream => ({
  name: '1080p', title: infoHash, filename: `${infoHash}.mkv`, infoHash, fileIdx: 0,
  quality: '1080p', sizeBytes: 1_000, seeders: 10, trackers: [],
});

test('keeps the latest list per title and caps how many titles it keeps', () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try {
    saveStreams('movie:tt1:-:-', [stream('a')]);
    saveStreams('movie:tt1:-:-', [stream('b')]);
    assert.deepEqual(loadStreams('movie:tt1:-:-')?.map((entry) => entry.infoHash), ['b']);
    // An empty lookup never erases a list that worked.
    saveStreams('movie:tt1:-:-', []);
    assert.equal(loadStreams('movie:tt1:-:-')?.[0].infoHash, 'b');
    for (let index = 0; index < 70; index += 1) saveStreams(`tv:tt2:1:${index}`, [stream(`e${index}`)]);
    assert.equal(loadStreams('movie:tt1:-:-'), null);
    assert.equal(loadStreams('tv:tt2:1:69')?.[0].infoHash, 'e69');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
