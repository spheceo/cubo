import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Stream } from '@cubo/core';
import { needsReencode, rememberReencode } from './decode-fallback';

const stream = (infoHash: string, fileIdx: number): Stream => ({
  name: '1080p', title: 'Show S01E01', filename: 'show.mkv', infoHash, fileIdx,
  quality: '1080p', sizeBytes: 2_000_000_000, seeders: 10, trackers: [],
});

test('a source that failed to decode re-encodes on later visits, per file', () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try {
    assert.equal(needsReencode(stream('pack', 3)), false);
    rememberReencode(stream('pack', 3));
    rememberReencode(stream('pack', 3));
    assert.equal(needsReencode(stream('pack', 3)), true);
    assert.equal(needsReencode(stream('pack', 4)), false);
    assert.equal(JSON.parse(values.get('cubo.reencode.v1') ?? '[]').length, 1);
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
