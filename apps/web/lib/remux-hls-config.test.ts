import assert from 'node:assert/strict';
import test from 'node:test';
import Hls from 'hls.js';
import { REMUX_HLS_CONFIG } from './remux-hls-config';

test('remux uses on-demand timing without a live synchronization target', () => {
  const hls = new Hls(REMUX_HLS_CONFIG);
  assert.equal(hls.config.startPosition, 0);
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1);
  assert.equal(hls.liveSyncPosition, null);
  hls.destroy();
});

test('startup outside EVENT window cannot trigger the hls.js live-edge jump', () => {
  const run = (remux: boolean) => {
    const hls = new Hls(remux ? REMUX_HLS_CONFIG : { startPosition: 0, lowLatencyMode: false, maxLiveSyncPlaybackRate: 1 });
    const media = { currentTime: 0, duration: 60, readyState: 2, playbackRate: 1 } as HTMLMediaElement;
    const internals = hls as unknown as {
      latencyController?: object;
      streamController: { media: HTMLMediaElement; synchronizeToLiveEdge: (details: object) => void };
    };
    // Feed a known live target to the installed controller, when enabled.
    // The old config's default infinite max latency does not stop this path.
    if (internals.latencyController) {
      Object.defineProperty(internals.latencyController, 'liveSyncPosition', { value: 48 });
    }
    internals.streamController.media = media;
    internals.streamController.synchronizeToLiveEdge({ fragmentStart: 1, edge: 60, targetduration: 6 });
    const position = media.currentTime;
    hls.destroy();
    return position;
  };
  assert.equal(run(false), 48);
  assert.equal(run(true), 0);
});
