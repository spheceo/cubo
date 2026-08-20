import { posterUrl, type MediaSummary } from '@cubo/core';
import { IoImageOutline } from 'react-icons/io5';
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
      className={`group relative block aspect-[2/3] cursor-pointer overflow-hidden rounded-xl border border-[#090909] bg-surface ${className}`}
      aria-label={item.title}
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#2a2a2a] px-4 text-center text-faint">
          <IoImageOutline size={34} />
          <p className="text-sm font-medium">No image found</p>
        </div>
      )}

      <div className="absolute inset-0 flex flex-col justify-end bg-linear-to-t from-black via-black/45 to-transparent p-4 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100">
        <h2 className="truncate text-xl font-semibold leading-tight text-white">{item.title}</h2>
        {year ? (
          <p className="mt-2 text-xl font-semibold leading-tight text-faint">{year}</p>
        ) : null}
      </div>
    </Link>
  );
}
