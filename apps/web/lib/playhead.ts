/**
 * Playhead is cached locally so a refresh can resume even when the last
 * Core POST never landed (beforeunload cannot wait on fetch). Core still
 * gets periodic writes; this file is the fast, sync source of truth.
 */
const STORAGE_KEY = 'cubo.playhead';
export const RESUME_MIN_SECONDS = 5;
export const RESUME_END_EPSILON = 3;
/** A leftover from a failed open (tens of seconds) must not seek into a
 *  brand-new torrent. A committed watch on another rip still resumes. */
export const CROSS_SOURCE_RESUME_MIN = 120;

export type StoredPlayhead = {
  positionSeconds: number;
  durationSeconds: number;
  updatedAt: number;
  infoHash?: string;
};

export function playableResume(
  positionSeconds: number,
  durationSeconds: number,
): number {
  if (!Number.isFinite(positionSeconds) || positionSeconds < RESUME_MIN_SECONDS) {
    return 0;
  }
  if (
    durationSeconds > RESUME_MIN_SECONDS &&
    positionSeconds >= durationSeconds - RESUME_END_EPSILON
  ) {
    return 0;
  }
  return positionSeconds;
}

/** Prefer the newer snapshot so a seek-back is not overwritten by Core. */
export function pickPlayhead(
  local: StoredPlayhead | null | undefined,
  remote: StoredPlayhead | null | undefined,
): StoredPlayhead | null {
  if (local == null) return remote ?? null;
  if (remote == null) return local;
  return local.updatedAt >= remote.updatedAt ? local : remote;
}

export function resumeSeconds(
  local: StoredPlayhead | null | undefined,
  remote: StoredPlayhead | null | undefined,
): number {
  const chosen = pickPlayhead(local, remote);
  if (!chosen) return 0;
  return playableResume(chosen.positionSeconds, chosen.durationSeconds);
}

/** Mid-play fallback always keeps `position`. A fresh open of a different
 *  torrent drops a short leftover so the player does not seek into a cold
 *  file; a real watch (2+ minutes) still resumes on the new rip. */
export function resumeForSource(
  position: number,
  savedInfoHash: string | null | undefined,
  streamInfoHash: string,
): number {
  if (!savedInfoHash || savedInfoHash === streamInfoHash) return position;
  if (position < CROSS_SOURCE_RESUME_MIN) return 0;
  return position;
}

export function loadPlayhead(playbackKey: string): StoredPlayhead | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, StoredPlayhead>;
    const value = parsed[playbackKey];
    if (!value || typeof value.positionSeconds !== 'number') return null;
    return {
      positionSeconds: value.positionSeconds,
      durationSeconds: typeof value.durationSeconds === 'number' ? value.durationSeconds : 0,
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
      infoHash: typeof value.infoHash === 'string' && value.infoHash ? value.infoHash : undefined,
    };
  } catch {
    return null;
  }
}

export function savePlayhead(
  playbackKey: string,
  positionSeconds: number,
  durationSeconds: number,
  infoHash?: string | null,
): void {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, StoredPlayhead>) : {};
    const previous = parsed[playbackKey];
    const nextHash =
      infoHash && infoHash.length > 0
        ? infoHash
        : typeof previous?.infoHash === 'string'
          ? previous.infoHash
          : undefined;
    parsed[playbackKey] = {
      positionSeconds,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
      updatedAt: Date.now(),
      ...(nextHash ? { infoHash: nextHash } : {}),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Private mode — Core still keeps the mapping.
  }
}
