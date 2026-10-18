import type { Stream } from '@cubo/core';
import { qualityRank, streamKey, weakSwarmRank } from './stream-select';

const STORAGE_KEY = 'cubo.sources.v1';
const MAX_SOURCES = 100;
const SHOW_STORAGE_KEY = 'cubo.show-sources.v1';
const MAX_SHOWS = 100;

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
    return validSource(saved);
  } catch {
    return null;
  }
}

/** The release a show last played from, for picking its next episode. */
export function rememberShowSource(mediaId: number, source: Stream): void {
  try {
    const saved = JSON.parse(localStorage.getItem(SHOW_STORAGE_KEY) ?? '{}') as Record<string, Stream>;
    const key = String(mediaId);
    delete saved[key];
    saved[key] = source;
    const entries = Object.entries(saved).slice(-MAX_SHOWS);
    localStorage.setItem(SHOW_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Playback must work when persistence is unavailable.
  }
}

export function loadShowSource(mediaId: number): Stream | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SHOW_STORAGE_KEY) ?? '{}')?.[String(mediaId)];
    return validSource(saved as Stream | undefined);
  } catch {
    return null;
  }
}

function validSource(saved: Stream | undefined): Stream | null {
  if (!saved || typeof saved.infoHash !== 'string' || !saved.infoHash
    || typeof saved.name !== 'string' || typeof saved.title !== 'string'
    || (saved.filename != null && typeof saved.filename !== 'string')
    || (saved.quality != null && typeof saved.quality !== 'string')
    || (saved.sizeBytes != null && (!Number.isFinite(saved.sizeBytes) || saved.sizeBytes < 0))
    || (saved.seeders != null && (!Number.isFinite(saved.seeders) || saved.seeders < 0))
    || !Array.isArray(saved.trackers) || !saved.trackers.every((value) => typeof value === 'string')
    || (saved.fileIdx != null && (!Number.isInteger(saved.fileIdx) || saved.fileIdx < 0))) return null;
  return saved;
}

/** Scene tags that end a release name without naming its group
 *  ("…1080p WEB-DL"). */
const NOT_A_GROUP = new Set(['dl', 'hd', 'rip', 'web', 'x264', 'x265', 'h264', 'h265', '264', '265', 'aac', 'dts', 'ma']);

/** The release group from a scene-style name: "…H 264-Kitsune",
 *  "…x265-KONTRAST.mp4", "…-RAWR[EZTVx.to].mkv". */
export function releaseGroup(stream: Stream): string | null {
  for (const name of [stream.title.split('\n')[0] ?? '', stream.filename ?? '']) {
    const match = /-([a-z0-9]{2,20})(?:\[[^\]]*\])?(?:\.(?:mkv|mp4|m4v|avi|webm))?\s*$/i.exec(name.trim());
    const group = match?.[1].toLowerCase();
    if (group && !NOT_A_GROUP.has(group)) return group;
  }
  return null;
}

/** The next episode of a show plays from the release the last one played
 *  from: the same season pack when it carries this episode (its torrent is
 *  already known, often with peers), else the same group's episode. Only
 *  within the leading quality tier, and never onto a near-dead swarm. */
export function preferContinuity(streams: Stream[], previous: Stream | null): Stream[] {
  const lead = streams[0];
  if (!previous || !lead) return streams;
  const eligible = (stream: Stream) =>
    qualityRank(stream) <= qualityRank(lead) && weakSwarmRank(stream) <= weakSwarmRank(lead);
  const group = releaseGroup(previous);
  const match =
    streams.find((stream) => stream.infoHash === previous.infoHash && eligible(stream))
    ?? (group ? streams.find((stream) => releaseGroup(stream) === group && eligible(stream)) : undefined);
  if (!match || match === lead) return streams;
  return [match, ...streams.filter((stream) => stream !== match)];
}

/** Provider order and seeder counts fluctuate; neither should switch rips.
 * A better quality tier does: a remembered 480p that won a race gives way
 * once the ranking leads with a 1080p. The caller still applies current
 * codec, size and language eligibility. */
export function preferSource(streams: Stream[], saved: Stream | null): Stream[] {
  if (!saved) return streams;
  const key = streamKey(saved);
  const matching = streams.find((stream) => streamKey(stream) === key);
  if (!matching) return streams;
  if (streams[0] && qualityRank(streams[0]) < qualityRank(matching)) return streams;
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
