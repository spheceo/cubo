import assert from 'node:assert/strict';
import test from 'node:test';
import Hls from 'hls.js';
import { sessionHlsConfig } from './session-hls-config';

test('sessions start hls.js at the resume point', () => {
  const hls = new Hls(sessionHlsConfig(2_431.5));
  assert.equal(hls.config.startPosition, 2_431.5);
  hls.destroy();
});

test('a start near zero plays from the beginning', () => {
  const hls = new Hls(sessionHlsConfig(0.4));
  assert.equal(hls.config.startPosition, 0);
  hls.destroy();
});

test('segment requests may wait on Core instead of timing out', () => {
  const hls = new Hls(sessionHlsConfig(0));
  const policy = hls.config.fragLoadPolicy.default;
  assert.ok(policy.maxTimeToFirstByteMs >= 60_000);
  assert.ok((policy.errorRetry?.maxNumRetry ?? 0) >= 4);
  hls.destroy();
});
