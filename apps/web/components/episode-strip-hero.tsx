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
import { IoChevronBack, IoChevronForward } from 'react-icons/io5';
import { IoMdInformationCircleOutline } from 'react-icons/io';
import { Link } from '@/components/link';
import { isUpcomingAirDate } from '@/lib/air-date';
import { formatRuntime } from '@/lib/format';
import {
  completedNearEnd,
  episodeLabel,
  historyForEpisode,
  type ContinueWatchingEntry,
} from '@/lib/library';
import { tmdbQueries } from '@/lib/queries';
import { CrossfadeImage } from './crossfade-image';
import { HeroTitle } from './featured-hero';
import { WatchPlayLink } from './watch-play-link';
import { useCore } from './core-provider';

/** Thumbnail width at rest; the picked one grows by `PICKED_SCALE`. */
const CARD_WIDTH = { narrow: 168, wide: 232 };
const CARD_GAP = { narrow: 18, wide: 28 };
const PICKED_SCALE = 1.3;
/** How far the picked thumbnail rises above its row. */
const PICKED_LIFT = 12;
/** Room above the picked thumbnail for its ring and rounded corners; the
 *  strip clips its overflow so neighbours can bleed off the sides. */
const PICKED_HEADROOM = 16;
/** The episode name under each thumbnail. */
const LABEL_HEIGHT = 32;
const EASE = 'cubic-bezier(.22,1,.36,1)';
/** Slow and smooth: the strip glides rather than snaps. */
const MOVE_MS = 900;

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

  usePreloadedStills(list, show, activeIndex);

  const step = (delta: number) => {
    const next = list[Math.min(list.length - 1, Math.max(0, activeIndex + delta))];
    if (next) setPicked(next.episodeNumber);
  };

  return (
    <section
      aria-label={`Continue watching ${show.title}`}
      className="relative flex min-h-[max(720px,92dvh)] flex-col overflow-hidden"
    >
      <CrossfadeImage src={image} />
      <div className="pointer-events-none absolute inset-0 bg-linear-to-r from-background via-background/70 via-35% to-transparent to-70%" />
      <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-background via-background/85 via-30% to-transparent to-60%" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-linear-to-b from-background/80 to-transparent" />

      {/* Top padding clears the site header: a long title grows the hero
          rather than sliding under the nav. */}
      <div className="relative z-10 flex flex-1 flex-col justify-end px-6 pt-24 sm:px-10">
        <div className="max-w-4xl">
          <HeroTitle title={show.title} />
        </div>
        <div className="mt-5 w-[600px] max-w-full space-y-5">
          {active ? (
            <EpisodeDetails
              key={active.episodeNumber}
              show={show}
              episode={active}
              newEpisode={entry.newEpisode && active.episodeNumber === entry.episode}
            />
          ) : (
            <div className="h-40" />
          )}
        </div>
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

/** The full-size picture each episode swaps in, fetched ahead so stepping
 *  along the strip never waits on the network. Starts once the page is
 *  idle, nearest the picked episode first, a couple at a time. */
function usePreloadedStills(episodes: Episode[], show: MediaDetails, activeIndex: number) {
  const keys = episodes.map((episode) => episode.stillPath ?? '').join('|');
  const startRef = useRef(activeIndex);
  startRef.current = activeIndex;

  useEffect(() => {
    if (!episodes.length) return;
    const start = startRef.current;
    const ordered = [...episodes.keys()]
      .sort((a, b) => Math.abs(a - start) - Math.abs(b - start))
      .map((index) => episodes[index].stillPath)
      .filter((path): path is string => Boolean(path))
      .map((path) => stillUrl(path, 'original'));
    ordered.push(backdropUrl(show.backdropPath, 'w1280'));

    let cancelled = false;
    let next = 0;
    const loading = new Set<HTMLImageElement>();
    const pump = () => {
      while (!cancelled && loading.size < 2 && next < ordered.length) {
        const image = new Image();
        image.decoding = 'async';
        loading.add(image);
        const done = () => {
          loading.delete(image);
          pump();
        };
        image.onload = done;
        image.onerror = done;
        image.src = ordered[next++];
      }
    };
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(pump, { timeout: 1500 })
      : window.setTimeout(pump, 300);
    return () => {
      cancelled = true;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
    // `keys` stands in for the episode list; restart only when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, show.backdropPath]);
}

/** The picked episode, in FeaturedHero's language: name as the kind, then
 *  episode and time, the synopsis, and the same play and info buttons. */
function EpisodeDetails({
  show,
  episode,
  newEpisode,
}: {
  show: MediaDetails;
  episode: Episode;
  newEpisode: boolean;
}) {
  const { library } = useCore();
  const row = historyForEpisode(
    library?.history,
    show.id,
    episode.seasonNumber,
    episode.episodeNumber,
  );
  const finished = row ? completedNearEnd(row) : false;
  const started = row != null && !finished && row.positionSeconds >= 5;
  const code = episodeLabel(episode.seasonNumber, episode.episodeNumber) ?? '';
  const minutesLeft = started
    ? Math.max(1, Math.round((row.durationSeconds - row.positionSeconds) / 60))
    : null;
  const details = [
    code,
    newEpisode ? 'New episode' : null,
    minutesLeft != null ? `${minutesLeft}m left` : formatRuntime(episode.runtime),
  ].filter(Boolean) as string[];

  return (
    <div className="hero-swap space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">{episode.name}</h2>
        {details.map((detail) => (
          <div key={detail} className="flex items-center gap-2">
            <p>•</p>
            <p>{detail}</p>
          </div>
        ))}
      </div>
      <p className="line-clamp-3 min-h-[4.5rem]">{episode.overview}</p>
      <div className="flex flex-wrap items-center gap-4">
        <WatchPlayLink
          href={watchHref(show, episode.seasonNumber, episode.episodeNumber)}
          label={started ? `Continue ${code}` : `Watch ${code}`}
          progress={started ? row.progress : 0}
        />
        <Link
          href={titleHref(show)}
          aria-label={`More information about ${show.title}`}
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-control"
        >
          <IoMdInformationCircleOutline size={25} />
        </Link>
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
  const transition = animate ? `transform ${MOVE_MS}ms ${EASE}` : 'none';
  const active = episodes[activeIndex];

  return (
    <div className="relative z-10 pb-8">
      <div className="mb-4 flex items-center justify-end gap-3 px-6 sm:px-10">
        <button
          type="button"
          aria-label="Previous episode"
          disabled={activeIndex === 0}
          onClick={() => onStep(-1)}
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-control transition-colors hover:bg-control-hover disabled:cursor-default disabled:opacity-40"
        >
          <IoChevronBack size={20} />
        </button>
        <button
          type="button"
          aria-label="Next episode"
          disabled={activeIndex === episodes.length - 1}
          onClick={() => onStep(1)}
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-control transition-colors hover:bg-control-hover disabled:cursor-default disabled:opacity-40"
        >
          <IoChevronForward size={20} />
        </button>
      </div>

      <div
        ref={frameRef}
        role="group"
        aria-label="Episodes"
        className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_3%,#000_97%,transparent)]"
        style={{ height: height * PICKED_SCALE + PICKED_LIFT + LABEL_HEIGHT + PICKED_HEADROOM }}
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
            height: height + LABEL_HEIGHT,
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
                    opacity: isActive ? 1 : index < activeIndex ? 0.3 : 0.55,
                    boxShadow: isActive ? '0 0 0 2px #fff' : '0 0 0 0 transparent',
                    transition: animate
                      ? `transform ${MOVE_MS}ms ${EASE}, opacity 700ms ease, box-shadow 700ms ease`
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
                <span
                  className={`mt-3 block truncate text-sm transition-colors duration-500 ${
                    isActive ? 'text-white' : 'text-faint'
                  }`}
                  style={{ width: isActive ? width + grow : width }}
                >
                  <span className="mr-1.5 tabular-nums text-faint">{episode.episodeNumber}</span>
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
