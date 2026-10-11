import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { recentStalls, stalledTooLong, stalledWithin, type Stall } from './starvation';

test('one long wait on the loader is starvation', () => {
  assert.equal(stalledTooLong([{ start: 0, end: null }], 19_000), false);
  assert.equal(stalledTooLong([{ start: 0, end: null }], 20_000), true);
});

test('a trickling source that stops at every segment is starvation too', () => {
  // Shark Tank S14E06 from one peer: ~10 s stops between 8 s of playback.
  const stalls: Stall[] = [];
  let at = 0;
  for (let i = 0; i < 4; i += 1) {
    stalls.push({ start: at, end: at + 10_000 });
    at += 18_000;
  }
  assert.equal(stalledWithin(stalls, at), 40_000);
  assert.equal(stalledTooLong(stalls, at), true);
});

test('the odd hiccup is not', () => {
  const stalls: Stall[] = [
    { start: 0, end: 12_000 },
    { start: 50_000, end: 62_000 },
  ];
  assert.equal(stalledTooLong(stalls, 70_000), false);
  // Stops older than the window no longer count.
  assert.equal(stalledWithin([{ start: 0, end: 30_000 }], 150_000), 0);
  assert.deepEqual(recentStalls([{ start: 0, end: 30_000 }, { start: 140_000, end: null }], 150_000), [
    { start: 140_000, end: null },
  ]);
});
