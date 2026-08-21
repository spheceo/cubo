/**
 * Subtitle cue parsing and lookup. External subtitle files are timed against
 * the ORIGINAL source file, but remuxed HLS playlists begin `timeOffset`
 * seconds into that source — callers must therefore look cues up against
 * absolute movie time (timeOffset + video.currentTime), never the raw player
 * position, or every cue fires early on remuxed sources.
 */

export type SubtitleCue = {
  start: number;
  end: number;
  text: string;
};

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity);
}

function timestampSeconds(stamp: string): number {
  const parts = stamp.trim().replace(',', '.').split(':');
  if (parts.length > 3 || parts.length < 2) return Number.NaN;
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length > 0 ? Number(parts[0]) : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) {
    return Number.NaN;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/** Parses WebVTT (the proxy converts SRT timestamps to VTT form). */
export function parseSubtitleCues(source: string): SubtitleCue[] {
  const normalized = source
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n');
  const cues: SubtitleCue[] = [];

  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue;

    const [rawStart, rawEnd] = lines[timingIndex].split('-->');
    if (!rawEnd) continue;
    const start = timestampSeconds(rawStart);
    const end = timestampSeconds(rawEnd.trim().split(/\s+/)[0] ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    // Strip voice/ styling tags; keep the text and its line breaks.
    const text = lines
      .slice(timingIndex + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!text) continue;

    cues.push({ start, end, text: decodeEntities(text) });
  }

  cues.sort((a, b) => a.start - b.start || b.end - a.end);
  return cues;
}

/** Returns the cue covering `time`, or null between cues. */
export function findActiveCue(cues: SubtitleCue[], time: number): SubtitleCue | null {
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const cue = cues[middle];
    if (cue.end <= time) low = middle + 1;
    else if (cue.start > time) high = middle - 1;
    else return cue;
  }
  return null;
}

const cueCache = new Map<string, Promise<SubtitleCue[]>>();

/** Fetches and parses a subtitle track once per session; failures are not
 *  cached so a transient proxy error can be retried on reselection. */
export function loadSubtitleCues(src: string): Promise<SubtitleCue[]> {
  const cached = cueCache.get(src);
  if (cached) return cached;

  const load = fetch(src)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then((text) => {
      const cues = parseSubtitleCues(text);
      if (cues.length === 0) {
        console.warn('[cubo] subtitle track parsed to zero cues:', src, text.slice(0, 80));
      }
      return cues;
    })
    .catch((error) => {
      console.warn('[cubo] subtitle track failed to load:', src, error);
      cueCache.delete(src);
      return [] as SubtitleCue[];
    });
  cueCache.set(src, load);
  return load;
}
