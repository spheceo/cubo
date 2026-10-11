import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { STILL_WATCHING_MS, markViewerActive, viewerStillWatching } from './viewer-activity';

test('the viewer counts as watching until two hours pass without input', () => {
  markViewerActive(1_000);
  assert.equal(viewerStillWatching(1_000 + 60 * 60 * 1000), true);
  assert.equal(viewerStillWatching(1_000 + STILL_WATCHING_MS - 1), true);
  // Asleep through the end of an episode: no rolling on into the next.
  assert.equal(viewerStillWatching(1_000 + STILL_WATCHING_MS), false);
  markViewerActive(1_000 + STILL_WATCHING_MS + 5);
  assert.equal(viewerStillWatching(1_000 + STILL_WATCHING_MS + 10), true);
});
