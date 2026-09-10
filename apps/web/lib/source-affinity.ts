import type { Stream } from '@cubo/core';
import { streamKey } from './stream-select';

const STORAGE_KEY = 'cubo.sources.v1';
const MAX_SOURCES = 100;

/** Remember actual playback, never a merely attempted torrent. */
export function rememberSource(key: string, source: Stream): void {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, Stream>;
    delete saved[key];
    saved[key] = source;
    const entries = Object.entries(saved).slice(-MAX_SOURCES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Playback must work when persistence is unavailable.
  }
}

export function loadSource(key: string): Stream | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')?.[key] as Stream | undefined;
    if (!saved || typeof saved.infoHash !== 'string' || !saved.infoHash
      || typeof saved.name !== 'string' || typeof saved.title !== 'string'
      || (saved.filename != null && typeof saved.filename !== 'string')
      || (saved.quality != null && typeof saved.quality !== 'string')
      || (saved.sizeBytes != null && (!Number.isFinite(saved.sizeBytes) || saved.sizeBytes < 0))
      || (saved.seeders != null && (!Number.isFinite(saved.seeders) || saved.seeders < 0))
      || !Array.isArray(saved.trackers) || !saved.trackers.every((value) => typeof value === 'string')
      || (saved.fileIdx != null && (!Number.isInteger(saved.fileIdx) || saved.fileIdx < 0))) return null;
    return saved;
  } catch {
    return null;
  }
}

/** Provider order and seeder counts fluctuate; neither should switch rips.
 * The caller still applies current codec, size and language eligibility. */
export function preferSource(streams: Stream[], saved: Stream | null): Stream[] {
  if (!saved) return streams;
  const key = streamKey(saved);
  const matching = streams.find((stream) => streamKey(stream) === key);
  if (!matching) return streams;
  return [matching, ...streams.filter((stream) => streamKey(stream) !== key)];
}

/** A confirmed failed source should not cost another cold-start timeout on
 * the next visit. Never clear a newer successful choice. */
export function forgetSource(key: string, infoHash: string): void {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (saved[key]?.infoHash !== infoHash) return;
    delete saved[key];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Persistence is best-effort.
  }
}
