import type { Stream } from '@cubo/core';
import { streamKey } from './stream-select';

const STORAGE_KEY = 'cubo.reencode.v1';
const MAX_SOURCES = 200;

/** Some releases carry video the browser cannot decode even though the
 *  codec is supported: frames Apple's hardware decoder rejects mid-stream,
 *  or interlaced broadcast captures. Desktop players decode around them in
 *  software; Cubo asks Core to re-encode the picture instead. A source that
 *  failed once re-encodes from the start on later visits, so it never has
 *  to fail again first. */
export function needsReencode(stream: Stream): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(saved) && saved.includes(streamKey(stream));
  } catch {
    return false;
  }
}

export function rememberReencode(stream: Stream): void {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    const key = streamKey(stream);
    const list = (Array.isArray(saved) ? saved : []).filter(
      (value): value is string => typeof value === 'string' && value !== key,
    );
    list.push(key);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_SOURCES)));
  } catch {
    // Persistence is best-effort; the next decode failure re-learns it.
  }
}
