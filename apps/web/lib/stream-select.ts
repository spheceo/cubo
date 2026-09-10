/**
 * Source ranking for playback and previews. Part of the verified-working
 * playback pipeline (see AGENTS.md): direct-play files outrank remux-needing
 * files within a quality tier so the ffmpeg converter stays a fallback.
 */
import type { Stream } from '@cubo/core';
import { isBrowserPlayableStream, isPlayableStream } from './media-compatibility';

// 4K rarely plays smoothly over a torrent bridge, so 1080p leads the order.
const QUALITY_RANK: Record<string, number> = {
  '1080p': 0,
  '720p': 1,
  '2160p': 2,
  '480p': 3,
};

const AUDIO_LANGUAGE_HINTS: [string, RegExp][] = [
  ['en', /\b(?:eng|english)\b/i],
  ['fr', /\b(?:fre|fra|french|truefrench|vff|vfq)\b/i],
  ['es', /\b(?:spa|spanish|castellano|latino)\b/i],
  ['de', /\b(?:ger|deu|german|deutsch)\b/i],
  ['it', /\b(?:ita|italian)\b/i],
  ['pt', /\b(?:por|portuguese|brazilian)\b/i],
  ['ru', /\b(?:rus|russian)\b/i],
  ['ja', /\b(?:jpn|japanese)\b/i],
  ['ko', /\b(?:kor|korean)\b/i],
  ['hi', /\b(?:hin|hindi)\b/i],
  ['zh', /\b(?:chi|zho|chinese|mandarin)\b/i],
  ['ar', /\b(?:ara|arabic)\b/i],
];
const ORIGINAL_AUDIO_RE = /\b(?:original[ ._-]?(?:audio|language))\b/i;
const MULTI_AUDIO_RE = /\b(?:multi|dual[ ._-]?audio)\b/i;
/** Named dubs (DUBLADO = Portuguese dubbed, etc.). Checked before flags —
 *  Torrentio often stamps 🇬🇧 on a dub because English subs are present. */
const DUBBED_AUDIO_RE = /\b(?:dublado|dublada|dublagem|dubbed|dubbing)\b/i;
/** Releases with subtitles burned into the picture (SUBBED/PLSUBBED, HC,
 *  KORSUB, VOSTFR, "napisy" …). No player setting can remove them, so they
 *  rank with the dubs — last. Soft-sub markers like MULTiSUBS stay fine. */
const HARDSUB_RE = /\b(?:hc|hard[ ._-]?subs?|\w*subbed|korsubs?|vostfr|napisy)\b/i;

/** In-theatre captures and pre-release screeners (CAM/CAMRip, TELESYNC/TS,
 *  TELECINE/TC, HDTS/HDTO, SCREENER/DVDSCR …). Torrentio labels these
 *  "1080p" based on the file's pixel dimensions, so quality alone cannot
 *  tell them apart from real releases; a camcorder pointed at a screen must
 *  never win an auto-pick over a genuine web/bluray rip. */
const CAPTURED_RELEASE_RE =
  /\b(?:cam(?:rip)?|telesync|telecine|ts|hdts|hdto|tc|screener|scr|dvdscr|bdscr|workprint)\b/i;

/** Torrentio marks stream languages with country-flag emoji — a far stronger
 *  dub signal than release-name tokens, since English-original releases
 *  almost never say "English" while dubs often carry only a flag. */
const FLAG_LANGUAGES: Record<string, string> = {
  '🇬🇧': 'en',
  '🇺🇸': 'en',
  '🇫🇷': 'fr',
  '🇪🇸': 'es',
  '🇲🇽': 'es',
  '🇩🇪': 'de',
  '🇮🇹': 'it',
  '🇵🇹': 'pt',
  '🇧🇷': 'pt',
  '🇷🇺': 'ru',
  '🇯🇵': 'ja',
  '🇰🇷': 'ko',
  '🇮🇳': 'hi',
  '🇨🇳': 'zh',
  '🇸🇦': 'ar',
  '🇳🇱': 'nl',
  '🇵🇱': 'pl',
  '🇹🇷': 'tr',
};

function flaggedLanguages(hint: string): Set<string> {
  const found = new Set<string>();
  for (const [flag, code] of Object.entries(FLAG_LANGUAGES)) {
    if (hint.includes(flag)) found.add(code);
  }
  return found;
}

function rank(stream: Stream): number {
  return QUALITY_RANK[stream.quality?.toLowerCase() ?? ''] ?? 4;
}

/** 0 = proper release, 1 = cinema capture / screener. Checked across name,
 *  title and filename: Torrentio carries the release type in `name`
 *  ("Torrentio\nCAM") while `quality` still reads "1080p". */
function capturedReleaseRank(stream: Stream): number {
  const hint = `${stream.name} ${stream.title} ${stream.filename ?? ''}`;
  return CAPTURED_RELEASE_RE.test(hint) ? 1 : 0;
}

/** Buckets seeders so "plenty" sources compete on bitrate instead of raw swarm size. */
function seederBucket(seeders: number | null): number {
  const value = seeders ?? 0;
  if (value >= 50) return 2;
  if (value >= 10) return 1;
  return 0;
}

function audioLanguageRank(stream: Stream, nativeLanguage: string | null): number {
  const hint = `${stream.name} ${stream.title} ${stream.filename ?? ''}`;
  // Burned-in subtitles ruin a release regardless of its audio language.
  if (HARDSUB_RE.test(hint)) return 3;
  if (DUBBED_AUDIO_RE.test(hint)) return 3;
  if (!nativeLanguage) return 1;
  const native = nativeLanguage.toLowerCase();
  if (ORIGINAL_AUDIO_RE.test(hint)) return 0;

  // Flags are authoritative when present: a release flagged only with
  // foreign languages is a dub even if its name carries no language tokens.
  // A UK flag next to other flags is usually subs on a dual/foreign
  // release, not proof of exclusive original audio — don't let that
  // outrank a flagless YTS / web-dl.
  const flags = flaggedLanguages(hint);
  if (flags.size > 0) {
    if (!flags.has(native)) return 3;
    return flags.size === 1 ? 0 : 1;
  }

  const nativeHint = AUDIO_LANGUAGE_HINTS.find(([code]) => code === native);
  if (nativeHint?.[1].test(hint)) return 0;
  if (MULTI_AUDIO_RE.test(hint)) return 2;
  if (AUDIO_LANGUAGE_HINTS.some(([code, pattern]) => code !== native && pattern.test(hint))) {
    return 3;
  }
  return 1;
}

/** What the current setup can play: `transcode` when the connected Core has
 *  ffmpeg, `hevc` when this browser decodes copy-remuxed HEVC. */
export interface PlaybackCapabilities {
  transcode: boolean;
  hevc: boolean;
}

/** Season + episode being requested, so season packs can be ranked below
 *  single-episode releases of the same quality. */
export interface EpisodeHint {
  season: number;
  episode: number;
}

/** A complete-season dump is almost never under 8 GB; a single 1080p
 *  episode rarely is. Used only when the name does not already say. */
const SEASON_PACK_SIZE_BYTES = 8 * 1024 * 1024 * 1024;

/** Blu-ray remuxes and other 1080p dumps above this sit last and are
 *  skipped by auto-pick. A 2–4 GB rip starts; a 30 GB remux fills the disk. */
export const AUTO_PLAY_MAX_BYTES = 12 * 1024 * 1024 * 1024;

/** Multi-title movie dumps (MCU saga, "Coleccion Volumen 4", "Marvel Films
 *  (2008 to 2021)"). One file inside a pack has a weak swarm for that
 *  piece range — even when the file itself is a direct-play MP4. */
const COLLECTION_PACK_RE =
  /\b(?:colecci[oó]n|collection|cinematic[ ._-]?universe|complete[ ._-]?(?:saga|collection|series|set)|infinity[ ._-]?saga|phase[ ._-]?[ivxl]+|volumen[ ._-]?\d+|marvel[ ._-]?films|great[ ._-]?films|films\s+\d{1,2}|[12]\d{3}\s*(?:[–—-]|to)\s*[12]\d{3})\b/i;

const TITLE_SIZE_RE = /💾\s*([\d.]+)\s*(TB|GB|MB)/i;

function streamHint(stream: Stream): string {
  return `${stream.name} ${stream.title} ${stream.filename ?? ''}`;
}

function episodeToken(season: number, episode: number): RegExp {
  return new RegExp(
    `(?:s0*${season}[ ._-]?e0*${episode}|${season}x0*${episode})(?:\\D|$)`,
    'i',
  );
}

function seasonPackToken(season: number): RegExp {
  return new RegExp(
    `(?:\\bcomplete\\b|\\bseason[ ._-]*0*${season}\\b|\\bs0*${season}\\b(?![ ._-]?e\\d))`,
    'i',
  );
}

/** 0 = this episode, 1 = unknown, 2 = season pack / complete dump.
 *  Size used to prefer a 2 GB S02E01 over a 26 GB "S02 COMPLETE". */
export function seasonPackRank(stream: Stream, episode?: EpisodeHint | null): number {
  if (!episode) return 0;
  const hint = streamHint(stream);
  // Torrentio can name the pack in its title and the selected episode in
  // filename. The filename does not turn the surrounding torrent into a
  // single-episode release; explicit pack metadata must win.
  if (seasonPackToken(episode.season).test(hint)) return 2;
  if (episodeToken(episode.season, episode.episode).test(hint)) return 0;
  if (streamSizeBytes(stream) >= SEASON_PACK_SIZE_BYTES) return 2;
  return 1;
}

/** 0 = single title, 2 = multi-movie collection / saga dump. */
export function collectionPackRank(stream: Stream): number {
  return COLLECTION_PACK_RE.test(streamHint(stream)) ? 2 : 0;
}

function packRank(stream: Stream, episode?: EpisodeHint | null): number {
  return Math.max(seasonPackRank(stream, episode), collectionPackRank(stream));
}

/** Prefer Core's videoSize, then the 💾 line Torrentio prints in `title`. */
export function streamSizeBytes(stream: Stream): number {
  if (stream.sizeBytes && stream.sizeBytes > 0) return stream.sizeBytes;
  const match = TITLE_SIZE_RE.exec(stream.title);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = match[2].toUpperCase();
  const multiplier =
    unit === 'TB' ? 1024 ** 4 : unit === 'GB' ? 1024 ** 3 : 1024 ** 2;
  return Math.round(value * multiplier);
}

/** 0 = normal rip, 1 = too large for auto-start (unknown size stays 0). */
export function oversizedRank(stream: Stream): number {
  const size = streamSizeBytes(stream);
  return size >= AUTO_PLAY_MAX_BYTES ? 1 : 0;
}

export function isOversizedStream(stream: Stream): boolean {
  return oversizedRank(stream) === 1;
}

/** Playable streams, best first: original-language audio (a dubbed release
 *  should never win the auto-pick), then real releases over cinema captures,
 *  then preferred quality, then a single title over a collection/season
 *  pack (a pack MP4 still has a weak swarm for that one file), then a
 *  normal-sized rip over a 12 GB+ remux, then direct-play files (fully
 *  seekable, no converter), then a healthy swarm, then the larger file
 *  (higher bitrate). When the connected Core can transcode, MKV and
 *  exotic-audio sources join the pool as the fallback within each tier. */
export function rankStreams(
  streams: Stream[],
  capabilities: PlaybackCapabilities,
  nativeLanguage: string | null = null,
  episode?: EpisodeHint | null,
): Stream[] {
  return streams
    .filter((stream) => isPlayableStream(stream, capabilities.transcode, capabilities.hevc))
    .sort((a, b) => {
      const byLanguage =
        audioLanguageRank(a, nativeLanguage) - audioLanguageRank(b, nativeLanguage);
      if (byLanguage !== 0) return byLanguage;
      const byCapture = capturedReleaseRank(a) - capturedReleaseRank(b);
      if (byCapture !== 0) return byCapture;
      const byQuality = rank(a) - rank(b);
      if (byQuality !== 0) return byQuality;
      const byPack = packRank(a, episode) - packRank(b, episode);
      if (byPack !== 0) return byPack;
      const bySizeClass = oversizedRank(a) - oversizedRank(b);
      if (bySizeClass !== 0) return bySizeClass;
      const byDirect =
        Number(isBrowserPlayableStream(b)) - Number(isBrowserPlayableStream(a));
      if (byDirect !== 0) return byDirect;
      const byBucket = seederBucket(b.seeders) - seederBucket(a.seeders);
      if (byBucket !== 0) return byBucket;
      const bySize = streamSizeBytes(b) - streamSizeBytes(a);
      if (bySize !== 0) return bySize;
      return (b.seeders ?? 0) - (a.seeders ?? 0);
    });
}

/** Direct-play preview sources only. Prefer a healthy 720p/1080p swarm and,
 * among similarly available files, the smaller download so playback starts
 * quickly. Preview never enters Core's ffmpeg remux path. */
export function rankPreviewStreams(
  streams: Stream[],
  nativeLanguage: string | null = null,
  episode?: EpisodeHint | null,
): Stream[] {
  const direct = streams.filter(
    (stream) => isBrowserPlayableStream(stream) && !isOversizedStream(stream),
  );
  const goodQuality = direct.filter((stream) =>
    ['720p', '1080p'].includes(stream.quality?.toLowerCase() ?? ''),
  );
  const candidates = goodQuality.length > 0 ? goodQuality : direct;

  return candidates.sort((a, b) => {
    const byLanguage =
      audioLanguageRank(a, nativeLanguage) - audioLanguageRank(b, nativeLanguage);
    if (byLanguage !== 0) return byLanguage;
    const byCapture = capturedReleaseRank(a) - capturedReleaseRank(b);
    if (byCapture !== 0) return byCapture;
    const byPack = packRank(a, episode) - packRank(b, episode);
    if (byPack !== 0) return byPack;
    const bySizeClass = oversizedRank(a) - oversizedRank(b);
    if (bySizeClass !== 0) return bySizeClass;
    const byBucket = seederBucket(b.seeders) - seederBucket(a.seeders);
    if (byBucket !== 0) return byBucket;
    const bySeeders = (b.seeders ?? 0) - (a.seeders ?? 0);
    if (bySeeders !== 0) return bySeeders;
    const bySize =
      (streamSizeBytes(a) || Number.MAX_SAFE_INTEGER) -
      (streamSizeBytes(b) || Number.MAX_SAFE_INTEGER);
    if (bySize !== 0) return bySize;
    return rank(a) - rank(b);
  });
}

export function streamKey(stream: Stream): string {
  return `${stream.infoHash}:${stream.fileIdx ?? 'auto'}`;
}
