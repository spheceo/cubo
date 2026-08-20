import type { Stream } from '@cubo/core';

const RISKY_MP4_CODEC_RE = /(?:x265|h[ ._-]?265|hevc|10[ ._-]?bit|dolby[ ._-]?vision)/i;
const RISKY_AUDIO_CODEC_RE =
  /(?:e[ ._-]?ac[ ._-]?3|ddp(?:lus)?|dd\+|dd(?:2|5|7)[ ._-]?\d|dolby[ ._-]?digital|ac[ ._-]?3|dts(?:[ ._-]?hd)?|truehd|atmos)/i;

export function isBrowserPlayableFilename(filename: string, codecHint = ''): boolean {
  const normalized = filename.trim().toLowerCase();
  if (normalized.endsWith('.webm')) return true;
  if (!normalized.endsWith('.mp4') && !normalized.endsWith('.m4v')) return false;
  const mediaHint = `${normalized} ${codecHint}`;
  return !RISKY_MP4_CODEC_RE.test(mediaHint) && !RISKY_AUDIO_CODEC_RE.test(mediaHint);
}

export function isBrowserPlayableStream(stream: Stream): boolean {
  return isBrowserPlayableFilename(
    stream.filename ?? stream.title.split('\n')[0] ?? '',
    `${stream.name} ${stream.title}`,
  );
}
