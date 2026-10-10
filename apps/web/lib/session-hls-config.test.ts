import assert from 'node:assert/strict';
import test from 'node:test';
import Hls, { type HlsConfig } from 'hls.js';
import { fitBufferToBitrate, sessionBufferSeconds, sessionHlsConfig } from './session-hls-config';

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

const MB = 1024 * 1024;

test('a 4K source buffers within the browser byte cap, a light one keeps the full goal', () => {
  // Paradise S01E01: 5.3 GB over 48 min, ~2 MB/s, with scenes at twice that.
  const uhd = sessionBufferSeconds(4 * MB);
  assert.ok(uhd.forward * 4 * MB + uhd.back * 4 * MB < 150 * MB);
  assert.ok(uhd.forward > 8, 'less than a segment ahead stalls at every segment');
  assert.deepEqual(sessionBufferSeconds(0.25 * MB), { forward: 60, back: 90 });
});

/** Just what `fitBufferToBitrate` uses; real hls.js controllers would
 *  choke on these stub events before the listener under test ran. */
function fakeHls() {
  const listeners = new Map<string, (event: string, data: unknown) => void>();
  const hls = {
    config: { ...sessionHlsConfig(0) } as HlsConfig,
    on: (event: string, listener: (event: string, data: unknown) => void) => listeners.set(event, listener),
    emit: (event: string, data: unknown) => listeners.get(event)?.(event, data),
  };
  fitBufferToBitrate(hls as unknown as Hls, Hls);
  return hls;
}

function loadFragment(hls: ReturnType<typeof fakeHls>, bytes: number, duration = 8) {
  hls.emit(Hls.Events.FRAG_LOADED, { frag: { type: 'main', duration }, payload: new ArrayBuffer(bytes) });
}

function refuseAppend(hls: ReturnType<typeof fakeHls>) {
  hls.emit(Hls.Events.ERROR, { details: Hls.ErrorDetails.BUFFER_FULL_ERROR, fatal: false });
}

test('the buffer goal follows the measured byte rate and recovers from hls.js shrinking it', () => {
  const hls = fakeHls();
  loadFragment(hls, 32 * MB);
  const goal = hls.config.maxMaxBufferLength;
  assert.ok(goal < 60 && goal >= 12, `goal ${goal}`);
  assert.equal(hls.config.maxBufferLength, goal);
  assert.ok(hls.config.backBufferLength < 90);
  // hls.js halves its goal after a refused append and never raises it again.
  hls.config.maxMaxBufferLength = 4;
  loadFragment(hls, 32 * MB);
  assert.equal(hls.config.maxMaxBufferLength, goal);
});

test('a refused append shrinks the byte budget, never below a segment ahead', () => {
  const hls = fakeHls();
  loadFragment(hls, 32 * MB);
  const goal = hls.config.maxMaxBufferLength;
  refuseAppend(hls);
  assert.ok(hls.config.maxMaxBufferLength < goal);
  for (let i = 0; i < 20; i += 1) refuseAppend(hls);
  assert.equal(hls.config.maxMaxBufferLength, 12);
});
