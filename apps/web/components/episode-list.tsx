import { stillUrl, type Episode, type SeasonSummary } from '@cubo/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import gsap from 'gsap';
import { useRef, useState } from 'react';
import { IoCalendarOutline, IoClose, IoList } from 'react-icons/io5';
import { Dropdown } from '@/components/dropdown';
import { Link } from '@/components/link';
import { useCore } from '@/components/core-provider';
import { formatNextEpisodeLabel } from '@/lib/air-date';
import { historyForEpisode } from '@/lib/library';
import { tmdbQueries } from '@/lib/queries';

export function EpisodeList({
  showId,
  seasons,
  initialSeason,
  initialEpisodes,
  size = 'lg',
}: {
  showId: number;
  seasons: SeasonSummary[];
  initialSeason: number;
  initialEpisodes?: Episode[];
  size?: 'md' | 'lg';
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [season, setSeason] = useState(initialSeason);
  const { library } = useCore();

  const seasonQuery = useQuery({
    ...tmdbQueries.season(showId, season),
    initialData:
      season === initialSeason && initialEpisodes && initialEpisodes.length > 0
        ? initialEpisodes
        : undefined,
    placeholderData: keepPreviousData,
  });
  const episodes = seasonQuery.data ?? [];
  const loading = seasonQuery.isFetching && seasonQuery.isPlaceholderData;
  const error = seasonQuery.error ? 'Could not load that season.' : null;

  function selectSeason(next: number) {
    if (next !== season) setSeason(next);
  }

  function openDialog() {
    const dialog = dialogRef.current;
    const panel = panelRef.current;
    if (!dialog || !panel) return;

    dialog.showModal();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    gsap.killTweensOf(panel);
    gsap.fromTo(
      panel,
      { xPercent: -104, autoAlpha: 0.7, scale: 0.985 },
      {
        xPercent: 0,
        autoAlpha: 1,
        scale: 1,
        duration: 0.65,
        ease: 'power4.out',
        clearProps: 'transform,opacity,visibility',
      },
    );
  }

  function closeDialog() {
    const dialog = dialogRef.current;
    const panel = panelRef.current;
    if (!dialog || !panel) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dialog.close();
      return;
    }

    gsap.killTweensOf(panel);
    gsap.to(panel, {
      xPercent: -104,
      autoAlpha: 0.55,
      scale: 0.985,
      duration: 0.42,
      ease: 'power3.in',
      onComplete: () => {
        dialog.close();
        gsap.set(panel, { clearProps: 'transform,opacity,visibility' });
      },
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className={`flex items-center justify-center rounded-full bg-surface font-semibold text-white transition-colors hover:bg-control ${
          size === 'lg' ? 'h-14 gap-3 px-7' : 'h-12 gap-2 px-5'
        }`}
      >
        <IoList size={size === 'lg' ? 22 : 20} />
        Episodes
      </button>

      <dialog
        ref={dialogRef}
        aria-label="Episodes"
        className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden bg-transparent p-0 text-white backdrop:bg-black/75"
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}
      >
        <section
          ref={panelRef}
          className="flex h-dvh w-full max-w-xl flex-col overflow-hidden bg-[#0c0c0c] shadow-[24px_0_80px_rgba(0,0,0,0.55)]"
        >
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 px-6 py-6">
            <div className="flex min-w-0 items-center gap-4">
              <h2 className="text-xl font-semibold">Episodes</h2>
              {seasons.length > 1 ? (
                <Dropdown
                  value={season}
                  options={seasons.map((entry) => ({
                    value: entry.seasonNumber,
                    label: entry.name || `Season ${entry.seasonNumber}`,
                  }))}
                  onChange={selectSeason}
                  ariaLabel="Season"
                />
              ) : null}
            </div>
            <button
              type="button"
              onClick={closeDialog}
              aria-label="Close episodes"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-control transition-colors hover:bg-control-hover"
            >
              <IoClose size={25} />
            </button>
          </header>

          <div className="min-h-0 flex-1 touch-pan-y overflow-y-scroll overscroll-contain p-3 [-webkit-overflow-scrolling:touch] sm:p-5">
            {error ? <p className="px-3 py-4 text-faint">{error}</p> : null}

            <ul className={`m-0 list-none space-y-2 p-0 ${loading ? 'opacity-40' : ''}`}>
              {episodes.map((episode) => {
                const still = stillUrl(episode.stillPath, 'w300');
                const airs = formatNextEpisodeLabel(episode);
                const watched = historyForEpisode(
                  library?.history,
                  showId,
                  episode.seasonNumber,
                  episode.episodeNumber,
                );
                const progress = watched
                  ? Math.min(1, watched.completed ? 1 : watched.progress)
                  : 0;
                return (
                  <li key={episode.id}>
                    <Link
                      href={`/watch/tv/${showId}?season=${episode.seasonNumber}&episode=${episode.episodeNumber}`}
                      className="group flex gap-4 rounded-xl p-3 transition-colors hover:bg-control"
                    >
                      <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-surface sm:w-44">
                        {still ? (
                          <img
                            src={still}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <IoCalendarOutline
                              size={28}
                              className="text-white/20"
                              aria-hidden
                            />
                          </div>
                        )}
                        {progress > 0 ? (
                          <div
                            className="absolute inset-x-0 bottom-0 h-1 bg-black/45"
                            aria-hidden
                          >
                            <div
                              className="h-full bg-star"
                              style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }}
                            />
                          </div>
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-sm text-faint">E{episode.episodeNumber}</span>
                          <p className="truncate font-semibold">{episode.name}</p>
                        </div>
                        {airs ? (
                          <p className="mt-1 text-sm text-white/70">{airs}</p>
                        ) : null}
                        <p className="mt-2 line-clamp-2 text-sm leading-6 text-white/60">
                          {episode.overview || 'No description available.'}
                        </p>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>

            {!loading && episodes.length === 0 ? (
              <p className="px-3 py-4 text-faint">No episodes were found for this season.</p>
            ) : null}
          </div>
        </section>
      </dialog>
    </>
  );
}
