import type { HlsConfig } from 'hls.js';

/** Core answers a segment request only once that part of the movie exists
 *  (the torrent may still be fetching it). Waiting on an open request is the
 *  normal way to buffer, not a failure. */
const SEGMENT_WAIT_MS = 70_000;

/** hls.js settings for Core playback sessions: a complete VOD playlist with
 *  real movie timestamps, so the player starts straight at the resume point
 *  and seeks anywhere without help. */
export function sessionHlsConfig(startPosition: number): Partial<HlsConfig> {
  return {
    startPosition: startPosition > 1 ? startPosition : 0,
    lowLatencyMode: false,
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    backBufferLength: 90,
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: SEGMENT_WAIT_MS,
        maxLoadTimeMs: SEGMENT_WAIT_MS + 30_000,
        timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 8, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
      },
    },
  };
}
