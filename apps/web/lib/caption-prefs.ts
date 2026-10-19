/**
 * Viewer caption preferences, persisted locally so they follow the viewer
 * across titles and sessions: turn captions on for one movie and the next
 * one opens with them on too (same language), switch them off here and they
 * stay off everywhere.
 */

export type CaptionSize = 'small' | 'medium' | 'large';

export type CaptionColor = 'white' | 'yellow' | 'cyan' | 'green';

export const CAPTION_COLORS: { value: CaptionColor; label: string; hex: string }[] = [
  { value: 'white', label: 'White', hex: '#ffffff' },
  { value: 'yellow', label: 'Yellow', hex: '#ffe066' },
  { value: 'cyan', label: 'Cyan', hex: '#66e0ff' },
  { value: 'green', label: 'Green', hex: '#8cf28c' },
];

export interface CaptionPrefs {
  enabled: boolean;
  /** ISO 639-1 language code of the last-picked track, when known. */
  language: string | null;
  size: CaptionSize;
  color: CaptionColor;
}

const STORAGE_KEY = 'cubo.captions.v1';

const DEFAULTS: CaptionPrefs = {
  enabled: false,
  language: null,
  size: 'medium',
  color: 'white',
};

export function loadCaptionPrefs(): CaptionPrefs {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<CaptionPrefs>;
    return {
      enabled: parsed.enabled === true,
      language: typeof parsed.language === 'string' ? parsed.language : null,
      size:
        parsed.size === 'small' || parsed.size === 'large' || parsed.size === 'medium'
          ? parsed.size
          : DEFAULTS.size,
      color: CAPTION_COLORS.some((entry) => entry.value === parsed.color)
        ? (parsed.color as CaptionColor)
        : DEFAULTS.color,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveCaptionPrefs(prefs: CaptionPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private-mode quota errors are fine to ignore; captions just won't stick.
  }
}

/** English subtitle tracks come as `en`, `eng` or a region tag (`en-US`). */
export function isEnglish(language: string): boolean {
  return /^en(g|-|$)/i.test(language);
}

/** Picks the track a saved preference points at: the viewer's own language
 *  first, then English, wherever either sits in the list, then anything. */
export function preferredSubtitleId(
  tracks: { id: string; language: string }[],
  prefs: CaptionPrefs,
): string | null {
  if (!prefs.enabled || tracks.length === 0) return null;
  const exact =
    prefs.language != null
      ? tracks.find((track) => track.language.toLowerCase() === prefs.language?.toLowerCase())
      : undefined;
  return (exact ?? tracks.find((track) => isEnglish(track.language)) ?? tracks[0]).id;
}
