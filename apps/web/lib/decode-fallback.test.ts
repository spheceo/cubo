import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Stream } from '@cubo/core';
import { needsReencode, rememberReencode } from './decode-fallback';

const stream = (infoHash: string, fileIdx: number): Stream => ({
  name: '1080p', title: 'Show S01E01', filename: 'show.mkv', infoHash, fileIdx,
  quality: '1080p', sizeBytes: 2_000_000_000, seeders: 10, trackers: [],
});

function withStorage(values: Map<string, string>, run: () => void) {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  try {
    run();
  } finally {
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test('a source re-encodes from the start once it failed to decode on two visits, per file', () => {
  const values = new Map<string, string>();
  withStorage(values, () => {
    assert.equal(needsReencode(stream('pack', 3)), false);
    rememberReencode(stream('pack', 3));
    assert.equal(needsReencode(stream('pack', 3)), false, 'one failure retries the browser decoder');
    rememberReencode(stream('pack', 3));
    assert.equal(needsReencode(stream('pack', 3)), true);
    assert.equal(needsReencode(stream('pack', 4)), false);
    assert.equal(JSON.parse(values.get('cubo.reencode.v2') ?? '[]').length, 1);
  });
});

test('sources remembered by the old store count as one failure', () => {
  const values = new Map([['cubo.reencode.v1', JSON.stringify(['pack:3'])]]);
  withStorage(values, () => {
    const legacy = JSON.parse(values.get('cubo.reencode.v1') ?? '[]');
    assert.equal(legacy.length, 1);
    assert.equal(needsReencode(stream('pack', 3)), false);
    rememberReencode(stream('other', 0));
    assert.equal(values.has('cubo.reencode.v1'), false);
    assert.equal(JSON.parse(values.get('cubo.reencode.v2') ?? '[]').length, 2);
    rememberReencode(stream('pack', 3));
    assert.equal(needsReencode(stream('pack', 3)), true);
  });
});
