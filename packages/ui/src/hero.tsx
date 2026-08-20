import { backdropUrl, type MediaSummary } from '@cubo/core';
import { IoMdInformationCircleOutline } from 'react-icons/io';
import { IoPlay } from 'react-icons/io5';
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
  const src = backdropUrl(item.backdropPath, 'original');
  const year = item.releaseDate.slice(0, 4);
  const kind = item.mediaType === 'tv' ? 'Series' : 'Film';

  return (
    <div className="relative h-[82dvh] overflow-hidden">
      <div className="relative h-full w-full overflow-hidden">
        {src ? (
          <img src={src} alt="" fetchPriority="high" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-surface" />
        )}

        <div className="relative z-10 flex h-full w-full flex-col justify-end px-10 pb-6 pt-10">
          <div className="w-[600px] max-w-full space-y-5">
            <h1 className="text-6xl font-bold sm:text-8xl">{item.title}</h1>
            <div className="flex items-center gap-2 text-xl font-semibold">
              <h2>{kind}</h2>
              {year ? (
                <>
                  <p>•</p>
                  <p>{year}</p>
                </>
              ) : null}
            </div>
            <p className="line-clamp-3">{item.overview}</p>
            <div className="flex items-center gap-4">
              <Link href={watchHref}>
                <span className="flex h-12 w-48 cursor-pointer items-center justify-center gap-2 rounded-full bg-white font-semibold text-black">
                  <IoPlay size={20} />
                  Watch Now
                </span>
              </Link>
              <Link
                href={href}
                aria-label={`More information about ${item.title}`}
                className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-control"
              >
                <IoMdInformationCircleOutline size={25} />
              </Link>
            </div>
          </div>
        </div>

        <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-background via-[#14141499] to-[#14141433]" />
      </div>
    </div>
  );
}
