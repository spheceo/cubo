import {
  backdropUrl,
  titleHref,
  watchHref,
  type MediaDetails,
} from '@cubo/core';
import { Info, Play } from '@phosphor-icons/react';
import { useRef } from 'react';
import { Link } from '@/components/link';
import { WatchLaterButton } from './watch-later-button';
import { watchLaterItem } from '@/lib/library';
import { AutoPreview } from './auto-preview';

export function FeaturedHero({ item }: { item: MediaDetails }) {
  const heroRef = useRef<HTMLElement>(null);
  const image = backdropUrl(item.backdropPath, 'original');
  const year = item.releaseDate.slice(0, 4);
  const kind = item.mediaType === 'tv' ? 'TV Show' : 'Film';

  return (
    <section ref={heroRef} className="relative isolate flex min-h-[42rem] items-end overflow-hidden bg-black sm:min-h-[48rem] lg:min-h-[min(92vh,58rem)]">
      {image ? (
        <img src={image} alt="" fetchPriority="high" className="absolute inset-0 -z-30 h-full w-full object-cover object-center" />
      ) : null}
      <AutoPreview item={item} />

      <div className="absolute inset-0 -z-10 bg-linear-to-t from-black via-black/55 to-black/12" />
      <div className="absolute inset-0 -z-10 bg-linear-to-r from-black/88 via-black/24 to-black/5" />
      <div className="absolute inset-x-0 bottom-0 -z-10 h-40 bg-linear-to-t from-ink to-transparent" />

      <div className="shell w-full pb-16 pt-36 sm:pb-20 lg:pb-24">
        <div className="max-w-3xl">
          <p className="flex items-center gap-2.5 text-[0.68rem] font-medium uppercase tracking-[0.15em] text-white/55">
            <span className="size-1.5 rounded-full bg-accent" />
            Featured {kind.toLowerCase()}
          </p>
          <h1 className="mt-5 text-balance text-5xl font-semibold leading-[0.94] tracking-[-0.065em] text-white sm:text-7xl lg:text-[6.75rem]">
            {item.title}
          </h1>
          <p className="mt-6 text-sm font-medium text-white/65">
            {year} <span className="mx-2 text-white/25">·</span> {kind}
          </p>
          <p className="mt-5 line-clamp-3 max-w-xl text-sm leading-relaxed text-white/62 sm:text-[0.98rem]">
            {item.overview}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href={watchHref(item)} className="inline-flex items-center gap-2.5 rounded-full bg-white px-6 py-3 text-sm font-semibold text-black transition duration-300 hover:scale-[1.02] hover:bg-accent">
              <Play weight="fill" className="size-3.5" />
              Watch now
            </Link>
            <WatchLaterButton item={watchLaterItem(item)} iconOnly />
            <Link href={titleHref(item)} aria-label={`More information about ${item.title}`} className="inline-flex size-11 items-center justify-center rounded-full border border-white/14 bg-white/8 text-white/80 backdrop-blur-md transition hover:border-white/30 hover:bg-white/14 hover:text-white">
              <Info className="size-5" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
