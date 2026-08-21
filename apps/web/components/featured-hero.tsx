import { backdropUrl, titleHref, watchHref, type MediaDetails } from '@cubo/core';
import { formatNextEpisodeLabel } from '@/lib/air-date';
import gsap from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { IoMdInformationCircleOutline } from 'react-icons/io';
import { IoPlay } from 'react-icons/io5';
import { Link } from '@/components/link';
import { formatRuntime } from '@/lib/format';
import { watchLaterItem } from '@/lib/library';
import { AutoPreview } from './auto-preview';
import { WatchLaterButton } from './watch-later-button';

/** Kino splits titles on a colon so the subtitle carries the display weight. */
function HeroTitle({ title }: { title: string }) {
  const [main, ...rest] = title.split(':');

  if (rest.length === 0) {
    return <h1 className="text-5xl font-bold sm:text-7xl lg:text-8xl">{title}</h1>;
  }

  return (
    <div className="flex-col font-bold">
      <h3 className="text-2xl sm:text-3xl">{main} :</h3>
      <h1 className="text-5xl sm:text-7xl lg:text-8xl">{rest.join(':').trim()}</h1>
    </div>
  );
}

export function FeaturedHero({ item }: { item: MediaDetails }) {
  const artworkRef = useRef<HTMLImageElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLDivElement>(null);
  const [previewing, setPreviewing] = useState(false);
  const hasPreviewed = useRef(false);
  const image = backdropUrl(item.backdropPath, 'w1280');
  const year = item.releaseDate.slice(0, 4);
  const nextAirs = item.nextEpisode ? formatNextEpisodeLabel(item.nextEpisode) : null;
  const kind =
    item.mediaType === 'tv'
      ? (nextAirs ?? 'Featured Show')
      : 'Featured Movie';
  const firstSeason = item.mediaType === 'tv' ? (item.seasons[0]?.seasonNumber ?? 1) : undefined;
  const playHref =
    item.mediaType === 'tv' ? watchHref(item, firstSeason ?? 1, 1) : watchHref(item);

  const details = [
    year,
    item.mediaType === 'tv'
      ? item.numberOfSeasons
        ? `${item.numberOfSeasons} ${item.numberOfSeasons === 1 ? 'Season' : 'Seasons'}`
        : null
      : formatRuntime(item.runtime),
  ].filter(Boolean) as string[];

  // Kino clears the metadata out of the way once a preview is playing, then
  // brings it back when the clip finishes.
  useEffect(() => {
    // Nothing to restore until a preview has actually taken over once.
    if (!previewing && !hasPreviewed.current) return;
    hasPreviewed.current = true;

    const targets = [detailsRef.current, descriptionRef.current].filter(Boolean);
    if (targets.length === 0) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const delay = previewing ? 2.8 : 0;
    const tween = gsap.to(targets, {
      autoAlpha: previewing ? 0 : 1,
      height: previewing ? 0 : 'auto',
      marginTop: previewing ? 0 : '',
      y: previewing ? 20 : 0,
      duration: previewing ? 1 : 0.9,
      delay,
      ease: previewing ? 'power3.inOut' : 'power2.out',
    });
    // The title settles slightly lower over the playing clip, then returns.
    const titleTween = gsap.to(titleRef.current, {
      y: previewing ? 36 : 0,
      duration: previewing ? 1 : 0.9,
      delay,
      ease: previewing ? 'power3.inOut' : 'power2.out',
    });
    const artwork = gsap.to(artworkRef.current, {
      opacity: previewing ? 0 : 1,
      duration: 1.2,
      ease: 'power2.out',
    });

    return () => {
      tween.kill();
      titleTween.kill();
      artwork.kill();
    };
  }, [previewing]);

  return (
    <div className="relative h-[82dvh] overflow-hidden">
      <div className="relative h-full w-full overflow-hidden">
        {image ? (
          <img
            ref={artworkRef}
            src={image}
            alt=""
            fetchPriority="high"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-surface" />
        )}
        <AutoPreview
          item={item}
          videoClassName="absolute inset-0 h-full w-full object-cover"
          controlClassName="absolute bottom-10 right-10 z-20"
          onActiveChange={setPreviewing}
        />

        <div className="relative z-10 flex h-full w-full flex-col justify-end px-6 pb-6 pt-10 sm:px-10">
          <div className="w-[600px] max-w-full space-y-5">
            <div ref={titleRef} className="will-change-transform">
            <HeroTitle title={item.title} />
          </div>

            <div ref={detailsRef} className="overflow-hidden">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold">{kind}</h2>
                {details.map((detail) => (
                  <div key={detail} className="flex items-center gap-2">
                    <p>•</p>
                    <p>{detail}</p>
                  </div>
                ))}
              </div>
            </div>

            <div ref={descriptionRef} className="overflow-hidden">
              <p className="line-clamp-3">{item.overview}</p>
            </div>

            <div className="flex items-center gap-4">
              <Link href={playHref}>
                <span className="flex h-12 w-48 cursor-pointer items-center justify-center gap-2 rounded-full bg-white font-semibold text-black">
                  <IoPlay size={20} />
                  Watch Now
                </span>
              </Link>
              <WatchLaterButton item={watchLaterItem(item)} />
              <Link
                href={titleHref(item)}
                aria-label={`More information about ${item.title}`}
                className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-control"
              >
                <IoMdInformationCircleOutline size={25} />
              </Link>
            </div>
          </div>
        </div>

        <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-background via-[#0a0a0a99] to-[#0a0a0a33]" />
      </div>
    </div>
  );
}
