/**
 * Viewer preferences for the timeline section markers (intro/credits/recap
 * bands on the scrub bar). Persisted locally like framing — the choices
 * follow the viewer across titles and sessions. Detection and skip actions
 * are unaffected; this only controls how the bar is annotated.
 */

const STORAGE_KEY = 'cubo.sections.v1';

/** Kinds the player annotates, in menu order, with their default colors.
 *  Generic `chapter` markers never render — a section only earns a band by
 *  carrying a real name. */
export const SECTION_KINDS = [
  { kind: 'intro', label: 'Intro', default: '#fbbf24' },
  { kind: 'recap', label: 'Recap', default: '#38bdf8' },
  { kind: 'credits', label: 'Credits', default: '#fb7185' },
  { kind: 'postcredits', label: 'Post-credits', default: '#f472b6' },
  { kind: 'preview', label: 'Preview', default: '#a78bfa' },
] as const;

/** Color for a kind outside SECTION_KINDS (e.g. a future section type). */
export const SECTION_FALLBACK_COLOR = '#52525b';

export type SectionKind = (typeof SECTION_KINDS)[number]['kind'];

/** Palette offered in the color picker — defaults are included so every
 *  kind can get back to its shipped look. */
export const SECTION_COLOR_OPTIONS = [
  { value: '#fbbf24', label: 'Amber' },
  { value: '#fb923c', label: 'Orange' },
  { value: '#fb7185', label: 'Rose' },
  { value: '#f472b6', label: 'Pink' },
  { value: '#a78bfa', label: 'Violet' },
  { value: '#38bdf8', label: 'Sky' },
  { value: '#34d399', label: 'Emerald' },
  { value: '#e2e8f0', label: 'White' },
  { value: '#52525b', label: 'Graphite' },
];

export interface SectionPrefs {
  visible: boolean;
  /** Per-kind color overrides; absent kinds use their default. */
  colors: Partial<Record<SectionKind, string>>;
}

const DEFAULTS: SectionPrefs = { visible: true, colors: {} };

export function loadSectionPrefs(): SectionPrefs {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    // v1 stored a bare boolean — upgrade it in place.
    if (typeof raw === 'boolean') return { visible: raw, colors: {} };
    if (raw === null || typeof raw !== 'object') return DEFAULTS;
    const record = raw as { visible?: unknown; colors?: unknown };
    const colors: Partial<Record<SectionKind, string>> = {};
    if (record.colors && typeof record.colors === 'object') {
      for (const { kind } of SECTION_KINDS) {
        const value = (record.colors as Record<string, unknown>)[kind];
        if (typeof value === 'string') colors[kind] = value;
      }
    }
    return { visible: record.visible !== false, colors };
  } catch {
    return DEFAULTS;
  }
}

export function saveSectionPrefs(prefs: SectionPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private-mode quota errors are fine to ignore; the pref just won't stick.
  }
}

/** Every kind resolved to a concrete color — overrides over defaults. */
export function sectionColorMap(prefs: SectionPrefs): Record<SectionKind, string> {
  const map = {} as Record<SectionKind, string>;
  for (const entry of SECTION_KINDS) map[entry.kind] = prefs.colors[entry.kind] ?? entry.default;
  return map;
}
