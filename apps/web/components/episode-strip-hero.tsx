import {
  backdropUrl,
  stillUrl,
  titleHref,
  watchHref,
  type Episode,
  type MediaDetails,
} from '@cubo/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IoChevronBack, IoChevronForward, IoPlay } from 'react-icons/io5';
import { IoMdInformationCircleOutline } from 'react-icons/io';
import { Link } from '@/components/link';
import { isUpcomingAirDate } from '@/lib/air-date';
import { completedNearEnd, historyForEpisode, type ContinueWatchingEntry } from '@/lib/library';
import { tmdbQueries } from '@/lib/queries';
import { CrossfadeImage } from './crossfade-image';
import { useCore } from './core-provider';

/** Thumbnail width at rest; the picked one grows by `PICKED_SCALE`. */
const CARD_WIDTH = { narrow: 168, wide: 232 };
const CARD_GAP = { narrow: 18, wide: 28 };
const PICKED_SCALE = 1.3;
/** How far the picked thumbnail rises above its row. */
const PICKED_LIFT = 12;
const EASE = 'cubic-bezier(.22,1,.36,1)';

/**
 * Home's hero while a show is in progress: the show fills the screen with its
 * season in a strip along the bottom. Picking an episode moves the hero onto
 * it (still, synopsis, play button) without leaving the page; Play starts
 * whichever one is picked. Everything moves on transforms, and the backdrop
 * crossfades, so stepping along the strip stays smooth.
 */
export function EpisodeStripHero({
  entry,
  show,
}: {
  entry: ContinueWatchingEntry;
  show: MediaDetails;
}) {
  const season = entry.season ?? 1;
  const episodes = useQuery(tmdbQueries.season(show.id, season));
  // Only what has aired: the strip is for watching, not the schedule.
  const list = (episodes.data ?? []).filter((episode) => !isUpcomingAirDate(episode.airDate));
  const [picked, setPicked] = useState<number | null>(null);
  const pickedNumber = picked ?? entry.episode ?? 1;
  const foundIndex = list.findIndex((episode) => episode.episodeNumber === pickedNumber);
  const activeIndex = foundIndex === -1 ? 0 : foundIndex;
  const active: Episode | undefined = list[activeIndex];
  const isEntryEpisode = active?.episodeNumber === entry.episode;

  const image = isEntryEpisode || !active?.stillPath
    ? backdropUrl(show.backdropPath, 'w1280')
    : stillUrl(active.stillPath, 'original');

  const step = (delta: number) => {
    const next = list[Math.min(list.length - 1, Math.max(0, activeIndex + delta))];
    if (next) setPicked(next.episodeNumber);
  };

  return (
    <section
      aria-label={`Continue watching ${show.title}`}
      className="relative flex h-[max(720px,92dvh)] flex-col overflow-hidden"
    >
      <CrossfadeImage src={image} />
      <div className="pointer-events-none absolute inset-0 bg-linear-to-r from-background/95 via-background/55 via-40% to-transparent to-75%" />
      <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-background via-background/80 via-25% to-transparent to-55%" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-linear-to-b from-background/80 to-transparent" />

      <div className="relative z-10 flex flex-1 flex-col justify-end px-6 sm:px-10">
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-white/70">
          {entry.newEpisode ? 'New episode' : 'Continue watching'}
        </p>
        <h1 className="mt-3 max-w-[14ch] text-5xl font-medium leading-none tracking-[-0.04em] sm:text-7xl lg:text-[5.5rem]">
          {show.title}
        </h1>
        {active ? (
          <EpisodeDetails key={active.episodeNumber} show={show} episode={active} />
        ) : (
          <div className="h-[11.5rem]" />
        )}
      </div>

      {list.length > 0 ? (
        <Strip
          episodes={list}
          activeIndex={activeIndex}
          showId={show.id}
          onPick={setPicked}
          onStep={step}
        />
      ) : (
        <div className="h-60" />
      )}
    </section>
  );
}

function EpisodeDetails({ show, episode }: { show: MediaDetails; episode: Episode }) {
  const { library } = useCore();
  const row = historyForEpisode(
    library?.history,
    show.id,
    episode.seasonNumber,
    episode.episodeNumber,
  );
  const finished = row ? completedNearEnd(row) : false;
  const started = row != null && !finished && row.positionSeconds >= 5;
  const minutesLeft = started
    ? Math.max(1, Math.round((row.durationSeconds - row.positionSeconds) / 60))
    : null;
  const label = started
    ? `Resume episode ${episode.episodeNumber}`
    : finished
      ? 'Watch again'
      : `Play episode ${episode.episodeNumber}`;
  const meta = started
    ? `${minutesLeft} min left`
    : finished
      ? 'Watched'
      : episode.runtime
        ? `${episode.runtime} min`
        : null;

  return (
    <div className="hero-swap">
      <p className="mt-5 text-lg tracking-[-0.01em] sm:text-[1.375rem]">
        <span className="text-faint">
          S{episode.seasonNumber} · E{episode.episodeNumber}
        </span>
        <span className="ml-3">{episode.name}</span>
      </p>
      <p className="mt-2 line-clamp-2 h-[3.25rem] max-w-xl text-base leading-[1.45] text-muted sm:h-14 sm:text-lg">
        {episode.overview}
      </p>
      <div className="mt-6 flex items-center gap-3">
        <Link
          href={watchHref(show, episode.seasonNumber, episode.episodeNumber)}
          className="relative flex h-12 cursor-pointer items-center gap-2.5 overflow-hidden rounded-full bg-white px-6 font-semibold text-black transition-colors hover:bg-white/85"
        >
          <IoPlay size={20} />
          {label}
          {started ? (
            <span
              aria-hidden
              className="absolute bottom-0 left-0 h-1 bg-star"
              style={{ width: `${Math.round(row.progress * 100)}%` }}
            />
          ) : null}
        </Link>
        <Link
          href={titleHref(show)}
          aria-label={`More information about ${show.title}`}
          className="flex h-12 w-12 cursor-pointer items-center justify-center rounded-full bg-white/10 backdrop-blur-sm transition-colors hover:bg-white/20"
        >
          <IoMdInformationCircleOutline size={25} />
        </Link>
        {meta ? <span className="ml-1 text-sm text-faint">{meta}</span> : null}
      </div>
    </div>
  );
}

function Strip({
  episodes,
  activeIndex,
  showId,
  onPick,
  onStep,
}: {
  episodes: Episode[];
  activeIndex: number;
  showId: number;
  onPick: (episodeNumber: number) => void;
  onStep: (delta: number) => void;
}) {
  const { library } = useCore();
  const frameRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusAfterStep = useRef(false);
  const [frameWidth, setFrameWidth] = useState(0);
  // The first layout lands in place; only later picks animate.
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => setFrameWidth(entry.contentRect.width));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (!focusAfterStep.current) return;
    focusAfterStep.current = false;
    cardRefs.current[activeIndex]?.focus({ preventScroll: true });
  }, [activeIndex]);

  const wide = frameWidth === 0 || frameWidth >= 640;
  const width = wide ? CARD_WIDTH.wide : CARD_WIDTH.narrow;
  const gap = wide ? CARD_GAP.wide : CARD_GAP.narrow;
  const gutter = wide ? 40 : 24;
  const height = Math.round((width * 9) / 16);
  const grow = Math.round(width * (PICKED_SCALE - 1));
  const stride = width + gap;
  // The picked card sits on the page gutter, except near the end of the
  // season, where the strip stops at its last card instead of running into
  // empty space.
  const stripWidth = (episodes.length - 1) * stride + width + grow;
  const maxScroll = Math.max(0, stripWidth + gutter * 2 - frameWidth);
  const scroll = Math.min(activeIndex * stride, frameWidth ? maxScroll : activeIndex * stride);
  const transition = animate ? `transform 700ms ${EASE}` : 'none';
  const active = episodes[activeIndex];

  return (
    <div className="relative z-10 pb-8">
      <div className="mb-4 flex items-center justify-end gap-3 px-6 sm:px-10">
        <span className="font-mono text-xs tracking-[0.12em] text-faint">
          {String(active?.episodeNumber ?? 0).padStart(2, '0')} / {String(episodes.at(-1)?.episodeNumber ?? 0).padStart(2, '0')}
        </span>
        <button
          type="button"
          aria-label="Previous episode"
          disabled={activeIndex === 0}
          onClick={() => onStep(-1)}
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/10 backdrop-blur-sm transition-colors hover:bg-white/20 disabled:cursor-default disabled:opacity-40"
        >
          <IoChevronBack size={20} />
        </button>
        <button
          type="button"
          aria-label="Next episode"
          disabled={activeIndex === episodes.length - 1}
          onClick={() => onStep(1)}
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/10 backdrop-blur-sm transition-colors hover:bg-white/20 disabled:cursor-default disabled:opacity-40"
        >
          <IoChevronForward size={20} />
        </button>
      </div>

      <div
        ref={frameRef}
        role="group"
        aria-label="Episodes"
        className="relative overflow-hidden"
        style={{ height: height * PICKED_SCALE + 64 }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          focusAfterStep.current = true;
          onStep(event.key === 'ArrowLeft' ? -1 : 1);
        }}
      >
        <div
          className="absolute bottom-0 left-0"
          style={{
            height: height + 52,
            transform: `translateX(${gutter - scroll}px)`,
            transition,
          }}
        >
          {episodes.map((episode, index) => {
            const isActive = index === activeIndex;
            const row = historyForEpisode(
              library?.history,
              showId,
              episode.seasonNumber,
              episode.episodeNumber,
            );
            const progress = row ? (completedNearEnd(row) ? 1 : row.progress) : 0;
            return (
              <button
                key={episode.episodeNumber}
                ref={(element) => {
                  cardRefs.current[index] = element;
                }}
                type="button"
                aria-current={isActive ? 'true' : undefined}
                aria-label={`Episode ${episode.episodeNumber}: ${episode.name}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onPick(episode.episodeNumber)}
                className="group absolute bottom-0 left-0 cursor-pointer text-left outline-none"
                style={{
                  width,
                  transform: `translateX(${index * stride + (index > activeIndex ? grow : 0)}px)`,
                  transition,
                }}
              >
                <div
                  className="relative overflow-hidden rounded-[10px] bg-surface group-focus-visible:outline-2 group-focus-visible:outline-offset-4 group-focus-visible:outline-white"
                  style={{
                    height,
                    transformOrigin: 'left bottom',
                    transform: isActive
                      ? `translateY(-${PICKED_LIFT}px) scale(${PICKED_SCALE})`
                      : 'none',
                    opacity: isActive ? 1 : index < activeIndex ? 0.45 : 0.8,
                    boxShadow: isActive ? '0 0 0 2px #fff' : '0 0 0 0 transparent',
                    transition: animate
                      ? `transform 700ms ${EASE}, opacity 500ms ease, box-shadow 500ms ease`
                      : 'none',
                  }}
                >
                  {episode.stillPath ? (
                    <img
                      src={stillUrl(episode.stillPath, 'w300')}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                  {progress > 0 ? (
                    <span className="absolute inset-x-2.5 bottom-2 h-[3px] overflow-hidden rounded-full bg-white/25">
                      <span
                        className="block h-full rounded-full bg-white"
                        style={{ width: `${Math.round(progress * 100)}%` }}
                      />
                    </span>
                  ) : null}
                </div>
                <span className="mt-3.5 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
                  Episode {String(episode.episodeNumber).padStart(2, '0')}
                </span>
                <span
                  className={`mt-1 block truncate text-[15px] transition-colors duration-300 sm:text-base ${
                    isActive ? 'text-white' : 'text-muted'
                  }`}
                  style={{ width: isActive ? width + grow : width }}
                >
                  {episode.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
