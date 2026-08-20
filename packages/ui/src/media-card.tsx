import { posterUrl, type MediaSummary } from '@cubo/core';
import type { LinkComponent } from './link';

export function MediaCard({
  item,
  href,
  linkComponent: Link = 'a',
  className = '',
}: {
  item: MediaSummary;
  href: string;
  linkComponent?: LinkComponent;
  className?: string;
}) {
  const src = posterUrl(item.posterPath, 'w342');
  const year = item.releaseDate.slice(0, 4);

  return (
    <Link
      href={href}
      className={`group block w-[10.5rem] shrink-0 text-left sm:w-[12.5rem] ${className}`}
      aria-label={item.title}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-2xl bg-surface ring-1 ring-line transition duration-500 ease-out group-hover:-translate-y-1 group-hover:ring-line-strong group-focus-visible:-translate-y-1">
        {src ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition duration-700 ease-out group-hover:scale-[1.045] group-focus-visible:scale-[1.045]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-3xl font-medium text-faint">
            {item.title.slice(0, 1)}
          </div>
        )}
        <div className="absolute inset-0 bg-linear-to-t from-black via-black/5 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100 group-focus-visible:opacity-100" />
        <div className="absolute inset-x-0 bottom-0 translate-y-2 p-4 opacity-0 transition duration-500 ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
          <p className="line-clamp-2 text-[0.86rem] font-medium leading-tight text-white">
            {item.title}
          </p>
          {year ? <p className="mt-1.5 text-[0.68rem] tabular-nums text-white/55">{year}</p> : null}
        </div>
      </div>
    </Link>
  );
}
