import type { CoreUpdateStatus, UpdatePhase } from './local-engine';

export function updateProgressPercent(progress: number | null | undefined): number | null {
  if (progress == null || progress <= 0) return null;
  return Math.min(100, Math.max(1, Math.round(progress * 100)));
}

export function updateInProgress(
  state: UpdatePhase | undefined,
  busy: boolean,
): boolean {
  return state === 'downloading' || state === 'applying' || busy;
}

function versionMatches(running: string, expected: string): boolean {
  return running === expected || `v${running}` === expected || running === expected.replace(/^v/, '');
}

/** The install finished once Core runs the expected version, or any version
 *  other than the one it ran before: GitHub can list a release before its
 *  build for this platform is uploaded, and Core then installs the newest
 *  release it can actually download. */
export function updateLanded(running: string, expected: string, from: string | null): boolean {
  return versionMatches(running, expected) || (from != null && !versionMatches(running, from));
}

export function displayTag(tag: string): string {
  return tag.startsWith('v') ? tag : `v${tag}`;
}

export function updateButtonLabel(
  status: Pick<CoreUpdateStatus, 'state' | 'progress'> &
    Partial<Pick<CoreUpdateStatus, 'latest'>>,
  busy = false,
): string {
  if (status.state === 'applying' || (busy && status.state === 'ready')) {
    return 'Installing…';
  }
  if (status.state === 'downloading' || busy) {
    const percent = updateProgressPercent(status.progress);
    return percent == null ? 'Updating…' : `Updating ${percent}%`;
  }
  return status.latest ? `Update to ${displayTag(status.latest)}` : 'Update';
}

/** Keep an in-flight download visible if a status poll races back to idle. */
export function mergeUpdateStatus(
  current: CoreUpdateStatus | null,
  next: CoreUpdateStatus,
  inFlight: boolean,
): CoreUpdateStatus {
  if (
    inFlight &&
    current &&
    current.state === 'downloading' &&
    next.state === 'idle'
  ) {
    return {
      ...next,
      state: 'downloading',
      progress: Math.max(current.progress ?? 0, next.progress ?? 0),
    };
  }
  if (current?.state === 'downloading' && next.state === 'downloading') {
    return {
      ...next,
      progress: Math.max(current.progress ?? 0, next.progress ?? 0),
    };
  }
  return next;
}
