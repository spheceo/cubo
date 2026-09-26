/**
 * Per-title audio choice for non-English originals: the original language
 * with English subtitles, or an English dub. Asked once per movie or show
 * and remembered, so every episode, the next-episode prefetch and the title
 * page warm-up all pick sources for the same audio.
 */
import type { MediaType } from '@cubo/core';
import type { AudioTarget } from './stream-select';

export type AudioChoice = 'original' | 'dub';

/** The dub on offer. Cubo's audience is English-speaking. */
export const DUB_LANGUAGE = 'en';

const STORAGE_KEY = 'cubo.audio.v1';
const MAX_TITLES = 200;

interface SavedChoice {
  /** Absent when the title never offered a dub but captions were set. */
  choice?: AudioChoice;
  /** The viewer switched subtitles off while listening to the original. */
  captionsOff?: boolean;
}

function titleKey(mediaType: MediaType, mediaId: number): string {
  return `${mediaType}:${mediaId}`;
}

function readAll(): Record<string, SavedChoice> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeEntry(key: string, entry: SavedChoice): void {
  try {
    const saved = readAll();
    delete saved[key];
    saved[key] = entry;
    const entries = Object.entries(saved).slice(-MAX_TITLES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Playback must work when persistence is unavailable.
  }
}

/** Whether a title can be offered an English dub at all. */
export function offersDub(originalLanguage: string | null): boolean {
  return originalLanguage != null && originalLanguage.toLowerCase() !== DUB_LANGUAGE;
}

export function loadAudioChoice(mediaType: MediaType, mediaId: number): AudioChoice | null {
  const saved = readAll()[titleKey(mediaType, mediaId)];
  return saved?.choice === 'original' || saved?.choice === 'dub' ? saved.choice : null;
}

export function saveAudioChoice(mediaType: MediaType, mediaId: number, choice: AudioChoice): void {
  const key = titleKey(mediaType, mediaId);
  writeEntry(key, { ...readAll()[key], choice });
}

export function loadCaptionsOff(mediaType: MediaType, mediaId: number): boolean {
  return readAll()[titleKey(mediaType, mediaId)]?.captionsOff === true;
}

export function saveCaptionsOff(mediaType: MediaType, mediaId: number, off: boolean): void {
  const key = titleKey(mediaType, mediaId);
  const current = readAll()[key];
  if ((current?.captionsOff === true) === off) return;
  writeEntry(key, { ...current, captionsOff: off });
}

/** What source ranking and Core should aim for. */
export function audioTargetFor(choice: AudioChoice | null, originalLanguage: string | null): AudioTarget {
  if (choice === 'dub' && offersDub(originalLanguage)) {
    return { dub: DUB_LANGUAGE, original: originalLanguage };
  }
  return originalLanguage;
}

/** The track language Core should play (ISO 639-1), if any. */
export function sessionAudioLanguage(target: AudioTarget): string | null {
  if (target !== null && typeof target === 'object') return target.dub;
  return target;
}

/** Stored choice resolved to a target, for callers outside the player. */
export function savedAudioTarget(
  mediaType: MediaType,
  mediaId: number,
  originalLanguage: string | null,
): AudioTarget {
  return audioTargetFor(loadAudioChoice(mediaType, mediaId), originalLanguage);
}

/** English display name for an ISO 639-1 code ("de" → "German"). */
export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name : null;
  } catch {
    return null;
  }
}
