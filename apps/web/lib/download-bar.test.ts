import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { watchableSpan } from './download-bar';

const islands = [
  { start: 0, end: 600 },
  { start: 601, end: 900 },
  { start: 1200, end: 1500 },
  { start: 2000, end: 2100 },
];

test('shows one stretch from the playhead to the first real gap', () => {
  assert.deepEqual(watchableSpan(islands, 5), [{ start: 0, end: 900 }]);
});

test('islands further ahead are not drawn', () => {
  assert.deepEqual(watchableSpan(islands, 1300), [{ start: 1200, end: 1500 }]);
});

test('a playhead in a hole shows nothing until that part arrives', () => {
  assert.deepEqual(watchableSpan(islands, 1000), []);
});

test('a fully downloaded file is one full bar', () => {
  assert.deepEqual(watchableSpan([{ start: 0, end: 6668 }], 3000), [{ start: 0, end: 6668 }]);
});
