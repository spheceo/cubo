import type { SkipSection, SkipSegments, SkipSegmentWindow } from './local-engine';
import type { SubtitleCue } from './subtitles';

/** A narrated recap opens within the first few minutes. */
const RECAP_SEARCH_SECONDS = 240;
/** Recaps cut straight to the titles or the episode: the first pause in
 *  dialogue this long ends one. */
const RECAP_GAP_SECONDS = 8;
const RECAP_MIN_SECONDS = 15;
const RECAP_MAX_SECONDS = 300;
/** "Next time on…" teasers sit in the last few minutes. */
const PREVIEW_SEARCH_SECONDS = 600;

// The narrator's own lead-ins, at the start of a cue. Ordinary dialogue
// ("…the next time I see you") never opens a cue with these plus "on" or
// a trailing ellipsis/dash.
const RECAP_LEAD = /^[\s.…-]*(previously|last time|last week)(\s+on\b|\s*[,.…:–—-])/i;
const PREVIEW_LEAD = /^[\s.…-]*(coming (soon|up)|next time|next week)(\s+on\b|\s*[,.…:–—-])/i;

function plainText(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
}

export interface RecapPreview {
  recap: SkipSegmentWindow | null;
  preview: SkipSegmentWindow | null;
}

/** Finds "Previously on…" recaps and "Coming soon on…" previews from the
 *  narrator's lead-in cues. Crowd databases rarely carry these for
 *  unscripted shows (The Traitors and the like), but the subtitles always
 *  say it. */
export function detectRecapPreview(
  cues: SubtitleCue[],
  durationSeconds: number,
  intro: SkipSegmentWindow | null = null,
): RecapPreview {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  return {
    recap: findRecap(sorted, intro),
    preview: durationSeconds > 0 ? findPreview(sorted, durationSeconds) : null,
  };
}

function findRecap(cues: SubtitleCue[], intro: SkipSegmentWindow | null): SkipSegmentWindow | null {
  const first = cues.findIndex(
    (cue) => cue.start <= RECAP_SEARCH_SECONDS && RECAP_LEAD.test(plainText(cue.text)),
  );
  if (first < 0) return null;
  const start = cues[first].start;
  let end = cues[first].end;
  let closed = false;
  for (const cue of cues.slice(first + 1)) {
    if (cue.start - end >= RECAP_GAP_SECONDS) {
      closed = true;
      break;
    }
    end = Math.max(end, cue.end);
    if (end - start > RECAP_MAX_SECONDS) return null;
  }
  if (!closed) return null;
  // The titles may start inside the last stretch of narration.
  if (intro && intro.start > start && intro.start < end) end = intro.start;
  if (end - start < RECAP_MIN_SECONDS) return null;
  return { start, end, source: 'subtitles' };
}

function findPreview(cues: SubtitleCue[], durationSeconds: number): SkipSegmentWindow | null {
  const from = durationSeconds - PREVIEW_SEARCH_SECONDS;
  const cue = cues.find(
    (entry) => entry.start >= from && entry.start < durationSeconds && PREVIEW_LEAD.test(plainText(entry.text)),
  );
  return cue ? { start: cue.start, end: null, source: 'subtitles' } : null;
}

/** Skip windows with subtitle-detected recaps and previews filled in where
 *  Core found none. A preview ends the episode, so it opens the credits
 *  prompt (Next episode) when it comes before the credits. */
export function withRecapPreview(segments: SkipSegments | null, found: RecapPreview): SkipSegments | null {
  if (!found.recap && !found.preview) return segments;
  const base: SkipSegments = segments ?? { intro: null, credits: null, sections: [] };
  const sections: SkipSection[] = [...base.sections];
  const has = (kind: string) => sections.some((section) => section.kind === kind);
  if (found.recap && !has('recap')) {
    sections.push({ ...found.recap, kind: 'recap', label: 'Recap' });
  }
  let credits = base.credits;
  if (found.preview && !has('preview')) {
    sections.push({ ...found.preview, kind: 'preview', label: 'Preview' });
  }
  const preview = sections.find((section) => section.kind === 'preview');
  if (preview && (!credits || preview.start < credits.start)) {
    credits = { start: preview.start, end: null, source: preview.source };
  }
  return { ...base, credits, sections };
}

/** The recap to offer a skip for: Core's (chapters, crowd data) first. */
export function recapWindow(segments: SkipSegments | null): SkipSegmentWindow | null {
  const recap = segments?.sections.find((section) => section.kind === 'recap' && section.end != null);
  return recap ? { start: recap.start, end: recap.end, source: recap.source } : null;
}
