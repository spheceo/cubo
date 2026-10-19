import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { WatchProvider } from '@cubo/core';
import { DEFAULT_SERVICE_COUNT, chosenServices, guessRegion } from './streaming-services';

const provider = (id: number): WatchProvider => ({ id, name: `P${id}`, logoPath: null });
const ids = (list: WatchProvider[]) => list.map((entry) => entry.id);

test('the time zone wins over a US-English browser', () => {
  assert.equal(guessRegion('Africa/Johannesburg', ['en-US']), 'ZA');
});

test('without a known zone, the first language naming a region decides', () => {
  assert.equal(guessRegion('Etc/UTC', ['en', 'pt-BR', 'de-DE']), 'BR');
  assert.equal(guessRegion(undefined, ['zh-Hant-TW']), 'TW');
});

test('defaults to the US when nothing says', () => {
  assert.equal(guessRegion(undefined, ['en']), 'US');
});

const all = [1, 2, 3, 4, 5, 6].map(provider);

test('until the viewer picks, the region leads with its subscription services', () => {
  // 2 is a rental store, 3 an unknown service: Netflix (8), Prime (119),
  // Apple TV+ (350) and Disney+ (337) lead in the region's order.
  const region = [8, 2, 119, 3, 350, 337, 15].map(provider);
  assert.deepEqual(ids(chosenServices(region)), [8, 119, 350, 337]);
});

test('a region without known subscriptions falls back to its leaders', () => {
  assert.deepEqual(ids(chosenServices(all)), ids(all.slice(0, DEFAULT_SERVICE_COUNT)));
});

test('picks keep their order and drop services the region lacks', () => {
  assert.deepEqual(ids(chosenServices(all, [5, 99, 2])), [5, 2]);
});

test('an empty pick stays empty', () => {
  assert.deepEqual(chosenServices(all, []), []);
});
