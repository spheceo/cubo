import { type MediaDetails } from '@cubo/core';
import { useGSAP } from '@gsap/react';
import { IoVolumeHigh, IoVolumeMute } from 'react-icons/io5';
import { gsap } from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { queryClient, streamQueries } from '@/lib/queries';
import {
  addMagnet,
  buildMagnet,
  largestFileIndex,
  streamUrl,
  waitUntilLive,
} from '@/lib/local-engine';
import { isBrowserPlayableFilename } from '@/lib/media-compatibility';
import { rankPreviewStreams } from '@/lib/stream-select';
import { useCore } from './core-provider';

const PREVIEW_SECONDS = 40;
const PREPARE_DELAY_MS = 100;

/** Preview randomness is stable for the day: the first visit picks a spot
 *  (and an episode, for shows), every later visit that day reuses it, and
 *  the choice is dropped at midnight so tomorrow feels fresh again. */
interface DailyPreviewChoice {
  day: string;
  season?: number;
  episode?: number;
  /** Position of the chosen start within the eligible span, 0..1. */
  fraction: number;
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

const PREVIEW_CHOICE_KEY = 'cubo.preview.v1';

function loadDailyChoice(key: string): DailyPreviewChoice | null {
  try {
    const all = JSON.parse(window.localStorage.getItem(PREVIEW_CHOICE_KEY) ?? '{}') as Record<
      string,
      DailyPreviewChoice
    >;
    const entry = all[key];
    if (!entry || entry.day !== todayStamp()) return null;
    if (typeof entry.fraction !== 'number' || Number.isNaN(entry.fraction)) return null;
    return entry;
  } catch {
    return null;
  }
}

function saveDailyChoice(key: string, choice: DailyPreviewChoice): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(PREVIEW_CHOICE_KEY) ?? '{}') as Record<
      string,
      DailyPreviewChoice
    >;
    // Drop stale days so the map cannot grow forever.
    const today = todayStamp();
    for (const existing of Object.keys(all)) {
      if (all[existing].day !== today) delete all[existing];
    }
    all[key] = choice;
    window.localStorage.setItem(PREVIEW_CHOICE_KEY, JSON.stringify(all));
  } catch {
    // Persistence is best-effort; randomize again next time instead.
  }
}

function choosePreviewEpisode(
  item: MediaDetails,
  key: string,
): { season: number; episode: number } | null {
  const eligibleSeasons = item.seasons.filter((season) => season.episodeCount > 1);
  if (eligibleSeasons.length === 0) return null;

  // Reuse today's episode when one was already picked; otherwise roll for a
  // new one and remember it until midnight.
  const saved = loadDailyChoice(key);
  if (saved?.season != null && saved.episode != null) {
    const known = eligibleSeasons.find((season) => season.seasonNumber === saved.season);
    if (known && saved.episode >= 1 && saved.episode <= known.episodeCount) {
      return { season: saved.season, episode: saved.episode };
    }
  }

  const season = eligibleSeasons[Math.floor(Math.random() * eligibleSeasons.length)];
  const firstHalfEnd = Math.min(
    season.episodeCount - 1,
    Math.max(1, Math.ceil(season.episodeCount / 2)),
  );

  return {
    season: season.seasonNumber,
    episode: 1 + Math.floor(Math.random() * firstHalfEnd),
  };
}

export function AutoPreview({
  item,
  videoClassName = 'absolute inset-0 -z-20 h-full w-full object-cover',
  controlClassName = 'absolute bottom-8 right-5 z-20 sm:bottom-10 sm:right-8',
  onActiveChange,
}: {
  item: MediaDetails;
  videoClassName?: string;
  controlClassName?: string;
  /** Fires when the preview takes over the artwork, and again when it ends. */
  onActiveChange?: (active: boolean) => void;
}) {
  const { connect } = useCore();
  const videoRef = useRef<HTMLVideoElement>(null);
  const startedRef = useRef(false);
  /** Episode picked for today's preview, persisted alongside the position. */
  const previewEpisodeRef = useRef<{ season?: number; episode?: number } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewActive, setPreviewActive] = useState(false);
  const activeChangeRef = useRef(onActiveChange);
  activeChangeRef.current = onActiveChange;
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    activeChangeRef.current?.(previewActive);
  }, [previewActive]);

  useEffect(() => {
    setPreviewUrl(null);
    setPreviewActive(false);
    setMuted(true);
    startedRef.current = false;
    previewEpisodeRef.current = null;

    if (!item.imdbId || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let cancelled = false;
    const abort = new AbortController();

    async function preparePreview() {
      try {
        const choiceKey = `${item.mediaType}:${item.id}`;
        const target = item.mediaType === 'tv' ? choosePreviewEpisode(item, choiceKey) : null;
        if (item.mediaType === 'tv' && !target) return;
        previewEpisodeRef.current = target ?? null;

        const connection = await connect();
        const streams = await queryClient.fetchQuery(
          streamQueries.streams(
            item.mediaType,
            item.imdbId as string,
            target?.season,
            target?.episode,
          ),
        );
        const source = rankPreviewStreams(streams, item.originalLanguage)[0];
        if (!source || cancelled) return;

        const added = await addMagnet(connection, buildMagnet(source), {
          mediaKey: `${item.mediaType}:${item.id}${
            target ? `:${target.season}:${target.episode}` : ''
          }`,
          title: item.title,
        });
        if (cancelled) return;

        const fileIndex = source.fileIdx ?? largestFileIndex(added.files);
        const filename = added.files[fileIndex]?.name ?? source.filename ?? '';
        if (!isBrowserPlayableFilename(filename, `${source.name} ${source.title}`)) return;

        const torrentId = added.id ?? added.infoHash;
        if (torrentId === null || torrentId === '') return;
        await waitUntilLive(connection, torrentId, {
          timeoutMs: 90_000,
          signal: abort.signal,
        });
        if (!cancelled) setPreviewUrl(streamUrl(connection, torrentId, fileIndex));
      } catch {
        // Artwork remains the complete fallback when Core or a preview source is unavailable.
      }
    }

    const idle = window.setTimeout(() => void preparePreview(), PREPARE_DELAY_MS);
    return () => {
      cancelled = true;
      // Stop the readiness polling immediately — hovering across several
      // titles would otherwise stack concurrent 500 ms poll loops.
      abort.abort();
      window.clearTimeout(idle);
      videoRef.current?.pause();
    };
  }, [connect, item]);

  useGSAP(
    () => {
      const video = videoRef.current;
      if (!video || !previewActive) return;

      const timeline = gsap.timeline();
      timeline
        .to(video, { autoAlpha: 1, duration: 1.8, ease: 'power2.inOut' })
        .to(video, {
          autoAlpha: 0,
          duration: 2.2,
          ease: 'power2.inOut',
          delay: PREVIEW_SECONDS,
          onStart: () => {
            // Ride the audio down with the picture instead of a hard cut.
            gsap.killTweensOf(video, 'volume');
            gsap.to(video, { volume: 0, duration: 2.2, ease: 'power2.inOut' });
          },
          onComplete: () => {
            video.pause();
            video.muted = true;
            video.volume = 1;
            setMuted(true);
            setPreviewActive(false);
          },
        });
      return () => timeline.kill();
    },
    { dependencies: [previewActive], revertOnUpdate: true },
  );

  /** Previews are ambience — never show embedded subtitle/caption tracks. */
  function disableTextTracks() {
    const video = videoRef.current;
    if (!video) return;
    for (let index = 0; index < video.textTracks.length; index += 1) {
      video.textTracks[index].mode = 'disabled';
    }
  }

  function positionPreview() {
    disableTextTracks();
    const video = videoRef.current;
    if (!video || startedRef.current || !Number.isFinite(video.duration) || video.duration <= 0) return;

    const latestStart = Math.max(
      0,
      Math.min(video.duration / 2, video.duration - PREVIEW_SECONDS - 6),
    );
    const earliestStart = Math.min(20, latestStart);
    const span = Math.max(0, latestStart - earliestStart);

    // One random spot per title per day — same clip on every visit today.
    const choiceKey = `${item.mediaType}:${item.id}`;
    let fraction = loadDailyChoice(choiceKey)?.fraction;
    if (fraction == null || !Number.isFinite(fraction)) {
      fraction = Math.random();
      saveDailyChoice(choiceKey, {
        day: todayStamp(),
        ...(previewEpisodeRef.current ?? {}),
        fraction,
      });
    }
    video.currentTime = earliestStart + fraction * span;
  }

  function startPreview() {
    const video = videoRef.current;
    if (!video || startedRef.current) return;
    startedRef.current = true;
    disableTextTracks();
    video.muted = true;
    void video
      .play()
      .then(() => setPreviewActive(true))
      .catch(() => {
        startedRef.current = false;
      });
  }

  function toggleAudio() {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !video.muted;
    gsap.killTweensOf(video, 'volume');
    if (nextMuted) {
      // Ease the sound away before actually muting so there is no hard cut.
      gsap.to(video, {
        volume: 0,
        duration: 0.45,
        ease: 'power2.out',
        onComplete: () => {
          video.muted = true;
          video.volume = 1;
        },
      });
    } else {
      video.volume = 0;
      video.muted = false;
      gsap.to(video, { volume: 1, duration: 0.9, ease: 'power2.out' });
    }
    setMuted(nextMuted);
  }

  if (!previewUrl) return null;

  return (
    <>
      <video
        ref={videoRef}
        src={previewUrl}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        onLoadedMetadata={positionPreview}
        onCanPlay={startPreview}
        onSeeked={startPreview}
        onError={() => setPreviewActive(false)}
        className={`invisible opacity-0 ${videoClassName}`}
      />
      {previewActive ? (
        <div className={controlClassName}>
          <button
            type="button"
            onClick={toggleAudio}
            aria-label={muted ? `Play ${item.title} preview audio` : `Mute ${item.title} preview`}
            aria-pressed={!muted}
            className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-[#1f1f1f] text-white shadow-[0_8px_24px_rgba(0,0,0,0.35)] transition-colors hover:bg-control-hover"
          >
            {muted ? <IoVolumeMute size={23} /> : <IoVolumeHigh size={23} />}
          </button>
        </div>
      ) : null}
    </>
  );
}
