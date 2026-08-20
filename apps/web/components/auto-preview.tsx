import { type MediaDetails } from '@cubo/core';
import { useGSAP } from '@gsap/react';
import { SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react';
import { gsap } from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { catalog } from '@/lib/api';
import {
  addMagnet,
  buildMagnet,
  largestFileIndex,
  streamUrl,
  waitUntilLive,
} from '@/lib/local-engine';
import { isBrowserPlayableFilename } from '@/lib/media-compatibility';
import { rankStreams } from '@/lib/stream-select';
import { useCore } from './core-provider';

const PREVIEW_SECONDS = 60;

export function AutoPreview({
  item,
  videoClassName = 'absolute inset-0 -z-20 h-full w-full object-cover',
  controlClassName = 'absolute bottom-8 right-5 z-20 sm:bottom-10 sm:right-8',
}: {
  item: MediaDetails;
  videoClassName?: string;
  controlClassName?: string;
}) {
  const { connect } = useCore();
  const videoRef = useRef<HTMLVideoElement>(null);
  const startedRef = useRef(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewActive, setPreviewActive] = useState(false);
  const [muted, setMuted] = useState(true);
  const firstSeason = item.mediaType === 'tv' ? (item.seasons[0]?.seasonNumber ?? 1) : undefined;

  useEffect(() => {
    setPreviewUrl(null);
    setPreviewActive(false);
    setMuted(true);
    startedRef.current = false;

    if (!item.imdbId || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let cancelled = false;

    async function preparePreview() {
      try {
        const connection = await connect();
        const streams = await catalog.streams.get(
          item.mediaType,
          item.imdbId as string,
          firstSeason,
          firstSeason == null ? undefined : 1,
        );
        const source = rankStreams(streams)[0];
        if (!source || cancelled) return;

        const added = await addMagnet(connection, buildMagnet(source), {
          mediaKey: `${item.mediaType}:${item.id}`,
          title: item.title,
        });
        if (cancelled) return;

        const fileIndex = source.fileIdx ?? largestFileIndex(added.files);
        const filename = added.files[fileIndex]?.name ?? source.filename ?? '';
        if (!isBrowserPlayableFilename(filename, `${source.name} ${source.title}`)) return;

        const torrentId = added.id ?? added.infoHash;
        if (torrentId === null || torrentId === '') return;
        await waitUntilLive(connection, torrentId, { timeoutMs: 90_000 });
        if (!cancelled) setPreviewUrl(streamUrl(connection, torrentId, fileIndex));
      } catch {
        // Artwork remains the complete fallback when Core or a preview source is unavailable.
      }
    }

    const idle = window.setTimeout(() => void preparePreview(), 900);
    return () => {
      cancelled = true;
      window.clearTimeout(idle);
      videoRef.current?.pause();
    };
  }, [connect, firstSeason, item.id, item.imdbId, item.mediaType, item.title]);

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
          onComplete: () => {
            video.pause();
            video.muted = true;
            setMuted(true);
            setPreviewActive(false);
          },
        });
      return () => timeline.kill();
    },
    { dependencies: [previewActive], revertOnUpdate: true },
  );

  function positionPreview() {
    const video = videoRef.current;
    if (!video || startedRef.current || !Number.isFinite(video.duration) || video.duration <= 0) return;

    const latestStart = Math.max(
      0,
      Math.min(video.duration / 2, video.duration - PREVIEW_SECONDS - 6),
    );
    const earliestStart = Math.min(20, latestStart);
    const span = Math.max(0, latestStart - earliestStart);
    video.currentTime = earliestStart + Math.random() * span;
  }

  function startPreview() {
    const video = videoRef.current;
    if (!video || startedRef.current) return;
    startedRef.current = true;
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
    video.muted = nextMuted;
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
            className="inline-flex size-11 cursor-pointer items-center justify-center rounded-full border border-white/20 bg-black/48 text-white shadow-lg backdrop-blur-xl transition duration-300 hover:scale-105 hover:border-white/35 hover:bg-black/68"
          >
            {muted ? <SpeakerSlash className="size-[1.1rem]" /> : <SpeakerHigh className="size-[1.1rem]" />}
          </button>
        </div>
      ) : null}
    </>
  );
}
