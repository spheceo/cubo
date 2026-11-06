import type { LocalEngineConnection, PlaybackUpdate } from '@/lib/local-engine';

/** What Cubo Player needs to take over playback (see crates/cubo-player). */
export interface CuboPlayerHandoff {
  magnet: string;
  fileIndex: number | null;
  mediaKey: string;
  title: string;
  startSeconds: number;
  audioLanguage: string | null;
  /** The library entry minus its position; the player fills that in. */
  progress: Omit<
    PlaybackUpdate,
    'positionSeconds' | 'durationSeconds' | 'watchedDeltaSeconds' | 'sessionWatchSeconds' | 'sessionStarted' | 'progressUpdatedAt'
  >;
}

/** Cubo Player is a Mac app; iPads also say "Macintosh" but have touch. */
export function isMacDesktop(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints <= 1;
}

export function canHandOffToCuboPlayer(connection: LocalEngineConnection | null | undefined): boolean {
  return Boolean(connection?.nativePlayer) && isMacDesktop();
}

function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The `cubo-player://play?…` link that opens this title in Cubo Player.
 *  It carries the Core's address and token: the player on this Mac talks to
 *  the same Core the page does. */
export function cuboPlayerLink(connection: LocalEngineConnection, handoff: CuboPlayerHandoff): string {
  const params = new URLSearchParams();
  params.set('core', connection.baseUrl);
  params.set('token', connection.token);
  params.set('magnet', handoff.magnet);
  if (handoff.fileIndex != null) params.set('fileIndex', String(handoff.fileIndex));
  params.set('mediaKey', handoff.mediaKey);
  params.set('title', handoff.title);
  params.set('start', String(Math.max(0, Math.floor(handoff.startSeconds))));
  if (handoff.audioLanguage) params.set('audioLanguage', handoff.audioLanguage);
  params.set('progress', base64Url(JSON.stringify(handoff.progress)));
  return `cubo-player://play?${params.toString()}`;
}
