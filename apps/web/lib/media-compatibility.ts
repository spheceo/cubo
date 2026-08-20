import type { Stream } from '@cubo/core';

/** Video no browser decodes and Core cannot copy-remux (Dolby Vision, AV1).
 *  These are skipped even when a converter is available. */
const UNSUPPORTED_VIDEO_RE = /(?:dolby[ ._-]?vision|\bav1\b)/i;
/** HEVC releases (x265, 10-bit). Browsers cannot play them directly, but
 *  Core copy-remuxes them to hvc1 fMP4 — playable where MSE reports HEVC
 *  support (macOS/iOS, hardware-backed Chrome). */
const HEVC_VIDEO_RE = /(?:x265|h[ ._-]?265|hevc|10[ ._-]?bit)/i;
/** Audio browsers cannot decode natively — fine when Core can transcode to AAC. */
const RISKY_AUDIO_CODEC_RE =
  /(?:e[ ._-]?ac[ ._-]?3|ddp(?:lus)?|dd\+|dd(?:2|5|7)[ ._-]?\d|dolby[ ._-]?digital|ac[ ._-]?3|dts(?:[ ._-]?hd)?|truehd|atmos)/i;

let hevcSupport: boolean | null = null;

/** True when MSE can decode copy-remuxed HEVC. Probed once; hls.js plays the
 *  remux through MSE, so this is exactly the capability the remux needs. */
export function supportsHevcRemux(): boolean {
  if (hevcSupport != null) return hevcSupport;
  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported) {
    hevcSupport = false;
    return hevcSupport;
  }
  hevcSupport = [
    'video/mp4; codecs="hvc1.1.6.L120.B0"',
    'video/mp4; codecs="hvc1.2.4.L120.B0"',
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
  ].some((type) => MediaSource.isTypeSupported(type));
  return hevcSupport;
}

/** Plays directly in a <video> element with no help from Core. */
export function isBrowserPlayableFilename(filename: string, codecHint = ''): boolean {
  const normalized = filename.trim().toLowerCase();
  if (normalized.endsWith('.webm')) return true;
  if (!normalized.endsWith('.mp4') && !normalized.endsWith('.m4v')) return false;
  const mediaHint = `${normalized} ${codecHint}`;
  return (
    !UNSUPPORTED_VIDEO_RE.test(mediaHint) &&
    !HEVC_VIDEO_RE.test(mediaHint) &&
    !RISKY_AUDIO_CODEC_RE.test(mediaHint)
  );
}

/** Playable after Core's fast remux: h264 (or HEVC where supported) in any
 *  common container, any audio (converted to AAC when needed). */
export function isRemuxableFilename(filename: string, codecHint = '', hevc = false): boolean {
  const normalized = filename.trim().toLowerCase();
  const knownContainer =
    normalized.endsWith('.mkv') ||
    normalized.endsWith('.mp4') ||
    normalized.endsWith('.m4v') ||
    normalized.endsWith('.webm');
  if (!knownContainer) return false;
  const mediaHint = `${normalized} ${codecHint}`;
  if (UNSUPPORTED_VIDEO_RE.test(mediaHint)) return false;
  return hevc || !HEVC_VIDEO_RE.test(mediaHint);
}

export function isBrowserPlayableStream(stream: Stream): boolean {
  return isBrowserPlayableFilename(streamFilename(stream), streamHint(stream));
}

/** Whether the stream can play at all, given the connected Core's abilities
 *  and this browser's HEVC decode support. */
export function isPlayableStream(stream: Stream, canTranscode: boolean, hevc = false): boolean {
  if (isBrowserPlayableStream(stream)) return true;
  return canTranscode && isRemuxableFilename(streamFilename(stream), streamHint(stream), hevc);
}

export function streamFilename(stream: Stream): string {
  return stream.filename ?? stream.title.split('\n')[0] ?? '';
}

export function streamHint(stream: Stream): string {
  return `${stream.name} ${stream.title}`;
}
