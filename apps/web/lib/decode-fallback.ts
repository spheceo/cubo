import type { Stream } from '@cubo/core';
import { streamKey } from './stream-select';

const STORAGE_KEY = 'cubo.reencode.v2';
const LEGACY_KEY = 'cubo.reencode.v1';
const MAX_SOURCES = 200;
/** Decode failures, on separate visits, before a source re-encodes from the
 *  start. One failure can be the machine (its hardware decoder busy with
 *  another app's export), not the file. */
const FAILURES_TO_REENCODE = 2;

interface Failures {
  key: string;
  failures: number;
}

/** Some releases carry video the browser cannot decode even though the
 *  codec is supported: frames Apple's hardware decoder rejects mid-stream,
 *  or interlaced broadcast captures. Desktop players decode around them in
 *  software; Cubo asks Core to re-encode the picture instead. A source that
 *  failed on two visits re-encodes from the start on later ones, so it
 *  never has to fail again first; after a single failure the next visit
 *  tries the browser's decoder again. */
export function needsReencode(stream: Stream): boolean {
  const key = streamKey(stream);
  return load().some((entry) => entry.key === key && entry.failures >= FAILURES_TO_REENCODE);
}

export function rememberReencode(stream: Stream): void {
  try {
    const key = streamKey(stream);
    const saved = load();
    const failures = (saved.find((entry) => entry.key === key)?.failures ?? 0) + 1;
    const list = [...saved.filter((entry) => entry.key !== key), { key, failures }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_SOURCES)));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Persistence is best-effort; the next decode failure re-learns it.
  }
}

/** v1 kept bare keys, each a single failure. */
function load(): Failures[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (Array.isArray(saved)) {
      return saved.filter(
        (entry): entry is Failures =>
          typeof entry?.key === 'string' && typeof entry?.failures === 'number',
      );
    }
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]');
    return Array.isArray(legacy)
      ? legacy.filter((key): key is string => typeof key === 'string').map((key) => ({ key, failures: 1 }))
      : [];
  } catch {
    return [];
  }
}
