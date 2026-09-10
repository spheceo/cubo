import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { previewStart } from './preview-start';

test('previews skip opening titles while keeping cold seeks in a bounded early scene', () => {
  assert.equal(previewStart(7200, 0), 300);
  assert.equal(previewStart(7200, 1), 420);
  assert.equal(previewStart(1800, 0), 180);
  assert.equal(previewStart(1800, 1), 300);
  assert.equal(previewStart(30, 1), 0);
  assert.equal(previewStart(NaN, 1), 0);
});

test('buffered opening logos are ignored but a buffered later scene can be reused', () => {
  assert.equal(previewStart(7200, 0.5, [[0, 90]]), 360);
  assert.equal(previewStart(7200, 0.5, [[400, 460]]), 400);
  assert.equal(previewStart(7200, 0.5, [[400, 410]]), 360);
  assert.equal(previewStart(7200, 0.5, [[5000, 5100]]), 360);
});
