import { backdropUrl, logoUrl, type LibraryItem } from '@cubo/core';
import { useState } from 'react';
import { IoClose } from 'react-icons/io5';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Link } from '@/components/link';
import { useCore } from './core-provider';

export function ContinueWatching({
  mediaType,
  className = 'mt-8',
}: {
  mediaType?: LibraryItem['mediaType'];
  className?: string;
}) {
  const { library, removeFromHistory } = useCore();
  const items = (library?.history ?? [])
    .filter((item) => item.positionSeconds >= 30 && item.progress < 0.9)
    .filter((item) => (mediaType ? item.mediaType === mediaType : true))
    .slice(0, 8);

  if (items.length === 0) return null;

  return (
    <section className={className}>
      <h2 className="text-2xl font-semibold">Continue Watching</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => (
          <ContinueWatchingCard
            key={item.key}
            item={item}
            onRemove={() => void removeFromHistory(item.key)}
          />
        ))}
      </div>
    </section>
  );
}

function ContinueWatchingCard({
  item,
  onRemove,
}: {
  item: LibraryItem;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const backdrop = backdropUrl(item.backdropPath, 'w780');
  const logo = logoUrl(item.logoPath, 'w300');
  const percent = Math.min(100, Math.round(item.progress * 100));
  const title = item.subtitle ? `${item.title} · ${item.subtitle}` : item.title;

  return (
    <>
      <div className="group">
        <Link
          href={item.watchHref}
          aria-label={`Continue ${title}`}
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
          <button
            type="button"
            aria-label="Remove from Continue Watching"
            onClick={(event) => {
              event.preventDefault();
              setConfirming(true);
            }}
            className="absolute right-3 top-3 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur-md transition-all duration-200 hover:bg-black/80 group-hover:opacity-100"
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
                {title}
              </h3>
            )}
          </div>
        </Link>
        <div className="mx-auto mt-3 h-1 w-[62%] overflow-hidden rounded-full bg-[#4f4f4f]">
          <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
        </div>
      </div>

      {confirming ? (
        <ConfirmDialog
          title="Remove from Continue Watching?"
          description={`Are you sure you want to remove ${title} from your continue watching list?`}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onRemove();
          }}
        />
      ) : null}
    </>
  );
}
