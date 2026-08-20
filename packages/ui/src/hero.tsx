import { backdropUrl, type MediaSummary } from '@cubo/core';
import type { LinkComponent } from './link';

export function Hero({
  item,
  href,
  watchHref,
  linkComponent: Link = 'a',
}: {
  item: MediaSummary;
  href: string;
  watchHref: string;
  linkComponent?: LinkComponent;
}) {
  const src = backdropUrl(item.backdropPath, 'w1280');
  const year = item.releaseDate.slice(0, 4);
  const kind = item.mediaType === 'tv' ? 'Series' : 'Film';

  return (
    <section className="relative isolate flex min-h-[32rem] items-end overflow-hidden sm:min-h-[38rem] lg:min-h-[min(84vh,44rem)]">
      {src ? (
        <img
          src={src}
          alt=""
          fetchPriority="high"
          className="absolute inset-0 -z-10 h-full w-full object-cover object-center"
        />
      ) : (
        <div className="absolute inset-0 -z-10 bg-surface" />
      )}
      <div className="absolute inset-0 -z-10 bg-linear-to-t from-ink via-ink/70 to-ink/10" />
      <div className="absolute inset-0 -z-10 bg-linear-to-r from-ink/85 via-ink/25 to-transparent" />

      <div className="shell w-full pb-14 pt-32 sm:pb-20 sm:pt-40">
        <p className="flex items-center gap-2.5 text-[0.7rem] font-medium tracking-[0.08em] text-muted uppercase">
          <span className="size-1 rounded-full bg-accent" />
          Featured {kind.toLowerCase()}
        </p>
        <h1 className="mt-4 max-w-3xl text-balance text-4xl font-semibold leading-[1.02] tracking-[-0.035em] text-fg sm:text-6xl lg:text-7xl">
          {item.title}
        </h1>
        <div className="mt-5 flex items-center gap-2.5 text-[0.8rem] tabular-nums text-muted">
          <span>{year}</span>
          <span className="text-line-strong">·</span>
          <span>{kind}</span>
        </div>
        <p className="mt-5 line-clamp-3 max-w-lg text-sm leading-relaxed text-muted sm:text-[0.95rem]">
          {item.overview}
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href={watchHref}
            className="inline-flex items-center gap-2 rounded-full bg-fg px-5 py-2.5 text-sm font-medium text-ink transition hover:bg-accent"
          >
            <svg viewBox="0 0 12 12" fill="currentColor" className="size-3">
              <path d="M2.5 1.3 10 6 2.5 10.7Z" />
            </svg>
            Watch now
          </Link>
          <Link
            href={href}
            className="rounded-full border border-line-strong px-5 py-2.5 text-sm font-medium text-fg/90 backdrop-blur-sm transition hover:border-fg/60 hover:bg-white/5"
          >
            More info
          </Link>
        </div>
      </div>
    </section>
  );
}
