import { backdropUrl, logoUrl, type LibraryItem } from '@cubo/core';
import { useQueries } from '@tanstack/react-query';
import gsap from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { IoClose } from 'react-icons/io5';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Link } from '@/components/link';
import {
  continueWatchingCandidates,
  continueWatchingEntries,
  finishedShowIds,
  type ContinueWatchingEntry,
} from '@/lib/library';
import { queryClient, tmdbQueries } from '@/lib/queries';
import { prefetchTitle } from '@/lib/source-prefetch';
import { useCore } from './core-provider';

/** How many Continue Watching cards get warmed on page load. */
const WARM_ITEMS = 3;

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function pinInPlace(element: HTMLElement, parent: HTMLElement) {
  const parentRect = parent.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  element.style.position = 'absolute';
  element.style.left = `${rect.left - parentRect.left}px`;
  element.style.top = `${rect.top - parentRect.top}px`;
  element.style.width = `${rect.width}px`;
  element.style.margin = '0';
  element.style.zIndex = '0';
  element.style.pointerEvents = 'none';
}

function animateRemoveFromGrid(grid: HTMLElement, card: HTMLElement): Promise<void> {
  const others = [...grid.children].filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node !== card,
  );
  const first = others.map((element) => ({ element, rect: element.getBoundingClientRect() }));

  gsap.killTweensOf([card, ...others]);
  pinInPlace(card, grid);
  for (const element of others) {
    element.style.position = 'relative';
    element.style.zIndex = '1';
  }

  const last = new Map(others.map((element) => [element, element.getBoundingClientRect()]));
  for (const { element, rect } of first) {
    const next = last.get(element);
    if (!next) continue;
    const x = rect.left - next.left;
    const y = rect.top - next.top;
    if (x === 0 && y === 0) continue;
    gsap.set(element, { x, y });
  }

  return new Promise((resolve) => {
    const timeline = gsap.timeline({
      onComplete: () => {
        gsap.set(others, { clearProps: 'transform,position,zIndex' });
        resolve();
      },
    });
    if (others.length > 0) {
      timeline.to(
        others,
        { x: 0, y: 0, duration: 0.45, ease: 'power3.out', stagger: 0.04 },
        0,
      );
      timeline.to(card, { autoAlpha: 0, duration: 0.18, ease: 'power2.in' }, 0.28);
    } else {
      timeline.to(card, { autoAlpha: 0, duration: 0.28, ease: 'power2.in' }, 0);
    }
  });
}

/** Continue Watching's cards, shared by the row and the home hero.
 *  `settled` once the shows whose cards hang on TMDB details have them. */
export function useContinueWatching(mediaType?: LibraryItem['mediaType']): {
  entries: ContinueWatchingEntry[];
  settled: boolean;
} {
  const { library } = useCore();
  const candidates = continueWatchingCandidates(library?.history, mediaType);
  // A finished episode's card depends on what has aired since.
  const showIds = finishedShowIds(candidates);
  const shows = useQueries({ queries: showIds.map((id) => tmdbQueries.details('tv', id)) });
  const detailsById = new Map(
    shows.flatMap((query) => (query.data ? [[query.data.id, query.data] as const] : [])),
  );
  return {
    entries: continueWatchingEntries(candidates, (id) => detailsById.get(id)),
    settled: shows.every((query) => !query.isLoading),
  };
}

export function ContinueWatching({
  mediaType,
  className = 'mt-8',
  excludeKey,
}: {
  mediaType?: LibraryItem['mediaType'];
  className?: string;
  /** A card shown elsewhere on the page (the home hero) stays out of the
   *  row; it is still warmed. */
  excludeKey?: string;
}) {
  const { removeFromHistory, connection } = useCore();
  const { entries: items } = useContinueWatching(mediaType);

  // Warm the first few play targets so "continue" starts at once: Core
  // fetches metadata, header and probe, then parks each torrent.
  const playable = items.filter((entry) => entry.kind !== 'waiting').slice(0, WARM_ITEMS);
  const warmKeys = playable
    .map((entry) => `${entry.item.mediaType}:${entry.item.mediaId}:${entry.season}:${entry.episode}`)
    .join('|');
  useEffect(() => {
    if (!connection?.sessions || !warmKeys) return;
    let cancelled = false;
    const targets = playable;
    void (async () => {
      for (const { item, season, episode } of targets) {
        if (cancelled) return;
        const details = await queryClient
          .fetchQuery(tmdbQueries.details(item.mediaType, item.mediaId))
          .catch(() => null);
        if (cancelled || !details) continue;
        await prefetchTitle(connection, {
          mediaType: item.mediaType,
          mediaId: item.mediaId,
          imdbId: details.imdbId ?? item.imdbId,
          title: item.title,
          originalLanguage: details.originalLanguage,
          season,
          episode,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // `playable` is rebuilt every render; the joined keys say when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, warmKeys]);
  const sectionRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const busy = useRef(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);

  const shown = items.filter((entry) => entry.item.key !== excludeKey);
  if (shown.length === 0) return null;

  async function removeItem(key: string) {
    if (busy.current) return;
    const grid = gridRef.current;
    const card = cardRefs.current.get(key);
    busy.current = true;
    setRemovingKey(key);

    try {
      if (grid && card && !prefersReducedMotion()) {
        const section = sectionRef.current;
        if (shown.length === 1 && section) {
          await new Promise<void>((resolve) => {
            gsap.to(section, {
              autoAlpha: 0,
              y: -10,
              duration: 0.32,
              ease: 'power2.in',
              onComplete: resolve,
            });
          });
        } else {
          await animateRemoveFromGrid(grid, card);
        }
      }
      await removeFromHistory(key);
    } catch {
      if (card) gsap.set(card, { clearProps: 'all', autoAlpha: 1, scale: 1 });
      if (grid) {
        gsap.set([...grid.children], { clearProps: 'transform' });
      }
    } finally {
      busy.current = false;
      setRemovingKey(null);
    }
  }

  return (
    <section ref={sectionRef} className={className}>
      <h2 className="text-2xl font-semibold">Continue Watching</h2>
      <div ref={gridRef} className="relative isolate mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {shown.map((entry) => (
          <ContinueWatchingCard
            key={entry.item.key}
            entry={entry}
            removing={removingKey === entry.item.key}
            cardRef={(element) => {
              if (element) cardRefs.current.set(entry.item.key, element);
              else cardRefs.current.delete(entry.item.key);
            }}
            onRemove={() => void removeItem(entry.item.key)}
          />
        ))}
      </div>
    </section>
  );
}

function ContinueWatchingCard({
  entry,
  onRemove,
  cardRef,
  removing,
}: {
  entry: ContinueWatchingEntry;
  onRemove: () => void;
  cardRef: (element: HTMLDivElement | null) => void;
  removing: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  const { item } = entry;
  const backdrop = backdropUrl(item.backdropPath, 'w780');
  const logo = logoUrl(item.logoPath, 'w300');
  const percent = Math.min(100, Math.round(entry.progress * 100));
  const episode = entry.label;
  const title = episode ? `${item.title} · ${episode}` : item.title;
  const action = entry.kind === 'resume' ? 'Continue' : entry.kind === 'next' ? 'Play' : 'Open';

  return (
    <div ref={cardRef} className="group" aria-busy={removing}>
      <Link
        href={entry.href}
        aria-label={`${action} ${title}${entry.newEpisode ? ', new episode' : ''}`}
        className="relative block aspect-video cursor-pointer overflow-hidden rounded-xl bg-white/[0.06] shadow-[0_12px_30px_rgba(0,0,0,0.28)]"
      >
        {backdrop ? (
          <img
            src={backdrop}
            alt=""
            className={`h-full w-full object-cover transition-transform duration-300 ${
              item.mediaType === 'tv'
                ? 'scale-110 group-hover:scale-[1.15]'
                : 'group-hover:scale-105'
            }`}
          />
        ) : null}
        <div className="absolute inset-0 bg-linear-to-t from-black/80 via-black/20 to-transparent" />
        {entry.newEpisode ? (
          <span className="absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur-md">
            <span aria-hidden className="size-1.5 rounded-full bg-white" />
            New episode
          </span>
        ) : null}
        <button
          type="button"
          aria-label="Remove from Continue Watching"
          disabled={removing}
          onClick={(event) => {
            event.preventDefault();
            setConfirming(true);
          }}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur-md transition-all duration-200 hover:bg-black/80 group-hover:opacity-100 disabled:cursor-wait"
        >
          <IoClose size={20} />
        </button>
        <div className="absolute inset-x-0 bottom-0 p-4">
          {logo ? (
            <img
              src={logo}
              alt={title}
              className="max-h-20 max-w-[72%] object-contain object-left-bottom"
            />
          ) : (
            <h3 className="line-clamp-2 max-w-[62%] text-xl font-semibold leading-tight text-white">
              {item.title}
            </h3>
          )}
          {episode ? (
            <p className="mt-2 text-sm font-semibold text-white/80">{episode}</p>
          ) : null}
        </div>
      </Link>
      <div className="mx-auto mt-3 h-1 w-[62%] overflow-hidden rounded-full bg-[#4f4f4f]">
        <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </div>

      {confirming ? (
        <ConfirmDialog
          title="Remove from Continue Watching?"
          description={`Are you sure you want to remove ${item.title} from your continue watching list?`}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onRemove();
          }}
        />
      ) : null}
    </div>
  );
}
