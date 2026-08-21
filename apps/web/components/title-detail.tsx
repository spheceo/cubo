import {
  backdropUrl,
  watchHref,
  type Episode,
  type MediaDetails,
} from '@cubo/core';
import gsap from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { FaStar } from 'react-icons/fa';
import { IoPlay } from 'react-icons/io5';
import { Link } from '@/components/link';
import { formatNextEpisodeLabel } from '@/lib/air-date';
import { formatRuntime } from '@/lib/format';
import { watchLaterItem } from '@/lib/library';
import { AutoPreview } from './auto-preview';
import { EpisodeList } from './episode-list';
import { WatchLaterButton } from './watch-later-button';

/** Kino's small-caps section label, reused for every block below the fold. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xl font-semibold text-white/50">{children}</h2>;
}

export function TitleDetail({
  details,
  episodes,
}: {
  details: MediaDetails;
  episodes: Episode[];
}) {
  const backdrop = backdropUrl(details.backdropPath, 'w1280');
  const year = details.releaseDate.slice(0, 4);
  const rating = details.voteAverage ? details.voteAverage.toFixed(1) : '';
  const runtime = formatRuntime(details.runtime);
  const firstSeason = details.seasons[0]?.seasonNumber ?? 1;
  const nextAirs = details.nextEpisode ? formatNextEpisodeLabel(details.nextEpisode) : null;
  const playHref =
    details.mediaType === 'tv'
      ? watchHref(details, firstSeason, episodes[0]?.episodeNumber ?? 1)
      : watchHref(details);

  return (
    <main className="h-dvh overflow-hidden bg-background text-white">
      <div className="relative h-full overflow-hidden">
        <InfoBackgroundStage details={details} backdrop={backdrop} />

        <section className="relative z-10 flex h-full max-w-[760px] flex-col justify-center overflow-hidden px-6 py-20 sm:px-10 md:px-20">
          <h1 className="text-4xl font-semibold leading-none tracking-normal sm:text-6xl">
            {details.title}
          </h1>

          <div className="flex flex-wrap items-center gap-2 py-7 text-xl font-semibold text-[#cccccf]">
            {rating ? (
              <div className="flex items-center gap-2">
                <FaStar className="text-star" />
                <span>{rating}/10</span>
              </div>
            ) : null}
            {rating && year ? <span>•</span> : null}
            {year ? <span>{year}</span> : null}
            {details.mediaType === 'tv' && details.numberOfSeasons ? (
              <>
                <span>•</span>
                <span>
                  {details.numberOfSeasons}{' '}
                  {details.numberOfSeasons === 1 ? 'Season' : 'Seasons'}
                </span>
              </>
            ) : null}
            {details.mediaType === 'movie' && runtime ? (
              <>
                <span>•</span>
                <span>{runtime}</span>
              </>
            ) : null}
            {nextAirs ? (
              <>
                <span>•</span>
                <span>{nextAirs}</span>
              </>
            ) : null}
          </div>

          {details.genres.length > 0 ? (
            <div className="flex flex-col gap-3">
              <SectionLabel>GENRES</SectionLabel>
              <div className="flex flex-wrap gap-3">
                {details.genres.slice(0, 3).map((genre) => (
                  <div key={genre} className="rounded-full bg-[#25252570] px-4 py-2 backdrop-blur">
                    <span>{genre}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {details.overview ? (
            <div className="flex flex-col gap-3 pt-10">
              <SectionLabel>SUMMARY</SectionLabel>
              <p className="line-clamp-4 max-w-[560px] leading-7 text-white/90">
                {details.overview}
              </p>
            </div>
          ) : null}

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link
              href={playHref}
              className="flex h-14 w-60 items-center justify-center gap-3 rounded-full bg-white font-semibold text-black"
            >
              <IoPlay size={22} />
              {details.mediaType === 'tv' ? 'Watch S1 E1' : 'Watch Now'}
            </Link>
            <WatchLaterButton item={watchLaterItem(details)} size="lg" />
            {details.mediaType === 'tv' && details.seasons.length > 0 ? (
              <EpisodeList
                showId={details.id}
                seasons={details.seasons}
                initialSeason={firstSeason}
                initialEpisodes={episodes}
              />
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

/** Kino's layered backdrop: gradients fade back while a preview is playing so
 *  the picture reads clearly, and a soft blur keeps the copy legible. */
function InfoBackgroundStage({
  details,
  backdrop,
}: {
  details: MediaDetails;
  backdrop: string;
}) {
  const artworkRef = useRef<HTMLImageElement>(null);
  const horizontalRef = useRef<HTMLDivElement>(null);
  const verticalRef = useRef<HTMLDivElement>(null);
  const blurRef = useRef<HTMLDivElement>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const tweens = [
      gsap.to(horizontalRef.current, {
        opacity: previewing ? 0.08 : 1,
        duration: 1,
        ease: 'power2.inOut',
      }),
      gsap.to(verticalRef.current, {
        opacity: previewing ? 0.06 : 1,
        duration: 1,
        ease: 'power2.inOut',
      }),
      gsap.to(blurRef.current, {
        opacity: previewing ? 1 : 0,
        duration: 1,
        ease: 'power2.inOut',
      }),
      gsap.to(artworkRef.current, {
        opacity: previewing ? 0 : 0.65,
        duration: 1.2,
        ease: 'power2.out',
      }),
    ];

    return () => {
      for (const tween of tweens) tween.kill();
    };
  }, [previewing]);

  return (
    <>
      {backdrop ? (
        <img
          ref={artworkRef}
          src={backdrop}
          alt=""
          fetchPriority="high"
          className="absolute inset-0 z-0 h-full w-full object-cover opacity-65"
        />
      ) : (
        <div className="absolute inset-0 z-0 bg-[#202020]" />
      )}
      <AutoPreview
        item={details}
        videoClassName="absolute inset-0 z-0 h-full w-full object-cover"
        controlClassName="absolute bottom-10 right-6 z-20 sm:right-10"
        onActiveChange={setPreviewing}
      />
      <div
        ref={horizontalRef}
        className="absolute inset-0 z-0 bg-linear-to-r from-black/70 via-black/42 to-black/12"
      />
      <div
        ref={verticalRef}
        className="absolute inset-0 z-0 bg-linear-to-t from-background/45 via-black/8 to-black/18"
      />
      <div
        ref={blurRef}
        className="pointer-events-none absolute inset-y-0 left-0 z-0 w-[64%] bg-linear-to-r from-black/16 via-black/6 to-transparent opacity-0 backdrop-blur-[2px] [mask-image:linear-gradient(to_right,black_0%,black_56%,transparent_100%)]"
      />
    </>
  );
}
