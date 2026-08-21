/**
 * Viewer framing preference: how the video layer fills the player. Persisted
 * locally so the choice follows the viewer across titles and sessions.
 */

export type FramingMode = 'fit' | 'fill-width' | 'fill-height' | 'auto';

export const FRAMING_LABELS: Record<FramingMode, string> = {
  fit: 'Fit',
  'fill-width': 'Fill width',
  'fill-height': 'Fill height',
  auto: 'Auto',
};

const STORAGE_KEY = 'cubo.framing.v1';

function isFramingMode(value: unknown): value is FramingMode {
  return value === 'fit' || value === 'fill-width' || value === 'fill-height' || value === 'auto';
}

export function loadFramingPref(): FramingMode {
  if (typeof window === 'undefined') return 'fit';
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    return isFramingMode(parsed) ? parsed : 'fit';
  } catch {
    return 'fit';
  }
}

export function saveFramingPref(mode: FramingMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(mode));
  } catch {
    // Private-mode quota errors are fine to ignore; framing just won't stick.
  }
}
