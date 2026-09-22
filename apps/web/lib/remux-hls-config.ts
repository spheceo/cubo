/** Core converts movies on demand; its growing EVENT playlist is not live TV. */
export const REMUX_HLS_CONFIG = {
  startPosition: 0,
  lowLatencyMode: false,
  maxLiveSyncPlaybackRate: 1,
  // A large max-latency threshold alone still lets hls.js seek to the live
  // edge when the playhead lies outside the current window during startup.
  // Disable the optional live-latency controller entirely. Explicit source
  // offsets, user seeks and ordinary buffering remain handled by the player.
  latencyController: undefined,
} as const;
