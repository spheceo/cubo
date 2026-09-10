/** A timeupdate can also be emitted by pause/seek. Only advancing playback
 * with future data is evidence that an earlier `waiting` event is stale. */
export function isAdvancingPlayback(
  previousTime: number | null,
  video: Pick<HTMLVideoElement, 'currentTime' | 'paused' | 'seeking' | 'readyState'>,
): boolean {
  return previousTime != null
    && Number.isFinite(previousTime)
    && Number.isFinite(video.currentTime)
    && video.currentTime > previousTime
    && !video.paused
    && !video.seeking
    && video.readyState >= 3; // HAVE_FUTURE_DATA
}
