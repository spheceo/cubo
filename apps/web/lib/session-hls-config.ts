import type Hls from 'hls.js';
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
    maxBufferLength: MAX_FORWARD_SECONDS,
    maxMaxBufferLength: 120,
    backBufferLength: MAX_BACK_SECONDS,
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

/** A browser refuses appends once a SourceBuffer holds about this much
 *  (Chrome caps video at 150 MB), so the buffer goals are budgeted in bytes:
 *  the forward and back buffers together stay under that cap. */
const FORWARD_BUFFER_BYTES = 90 * 1024 * 1024;
const BACK_BUFFER_BYTES = 30 * 1024 * 1024;
const MAX_FORWARD_SECONDS = 60;
const MAX_BACK_SECONDS = 90;
/** More than one whole segment (~8 s) ahead, so the next one always loads
 *  while the current one plays. */
const MIN_FORWARD_SECONDS = 12;
const MIN_BACK_SECONDS = 10;
/** Fragments whose byte rate is remembered; the peak sizes the buffer so a
 *  busy scene does not overflow it. */
const RATE_WINDOW = 6;

/** Seconds hls.js may buffer ahead of and behind the playhead for a source
 *  at `bytesPerSecond`, within `forwardBytes` ahead. */
export function sessionBufferSeconds(
  bytesPerSecond: number,
  forwardBytes = FORWARD_BUFFER_BYTES,
): { forward: number; back: number } {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  return {
    forward: clamp(forwardBytes / bytesPerSecond, MIN_FORWARD_SECONDS, MAX_FORWARD_SECONDS),
    back: clamp(BACK_BUFFER_BYTES / bytesPerSecond, MIN_BACK_SECONDS, MAX_BACK_SECONDS),
  };
}

/** Keeps a session's hls.js buffer goals inside the browser's byte cap.
 *  hls.js budgets in seconds: at 4K bitrates its goals overflow the cap,
 *  and every refused append halves its goal for good. After a few, it
 *  buffers ~4 s and pauses at every segment of a fully downloaded file. So
 *  the goals follow the measured byte rate, a refused append shrinks the
 *  byte budget instead, and the goal never drops below a segment ahead. */
export function fitBufferToBitrate(hls: Hls, { Events, ErrorDetails }: typeof Hls): () => BufferSizing {
  const rates: number[] = [];
  let forwardBytes = FORWARD_BUFFER_BYTES;
  let refusedAppends = 0;
  const apply = () => {
    if (!rates.length) return;
    const { forward, back } = sessionBufferSeconds(Math.max(...rates), forwardBytes);
    hls.config.maxBufferLength = forward;
    hls.config.maxMaxBufferLength = forward;
    hls.config.backBufferLength = back;
  };
  hls.on(Events.FRAG_LOADED, (_event, { frag, payload }) => {
    if (frag.type !== 'main' || !(frag.duration > 0) || !payload.byteLength) return;
    rates.push(payload.byteLength / frag.duration);
    if (rates.length > RATE_WINDOW) rates.shift();
    apply();
  });
  hls.on(Events.ERROR, (_event, data) => {
    if (data.details !== ErrorDetails.BUFFER_FULL_ERROR) return;
    refusedAppends += 1;
    forwardBytes *= 0.7;
    apply();
  });
  return () => ({
    goalSeconds: hls.config.maxMaxBufferLength,
    backSeconds: hls.config.backBufferLength,
    peakBytesPerSecond: rates.length ? Math.max(...rates) : null,
    forwardBudgetBytes: forwardBytes,
    refusedAppends,
  });
}

/** How a session's buffer is sized right now, for diagnostics. */
export interface BufferSizing {
  goalSeconds: number;
  backSeconds: number;
  /** Peak byte rate of recent fragments; null before the first loads. */
  peakBytesPerSecond: number | null;
  forwardBudgetBytes: number;
  /** Appends the browser refused for lack of room this source. */
  refusedAppends: number;
}
