import { posterUrl, type MediaSummary } from '@cubo/core';

export function MediaCard({
  item,
  onSelect,
}: {
  item: MediaSummary;
  onSelect?: (item: MediaSummary) => void;
}) {
  const src = posterUrl(item.posterPath, 'w342');
  const year = item.releaseDate.slice(0, 4);

  return (
    <button
      type="button"
      className="w-40 cursor-pointer text-left transition-transform hover:scale-105 hover:shadow-lg"
      onClick={() => onSelect?.(item)}
    >
      {src ? (
        <img
          src={src}
          alt={item.title}
          className="aspect-[2/3] w-full rounded-xl object-cover"
        />
      ) : (
        <div className="flex aspect-[2/3] w-full items-center justify-center rounded-xl bg-zinc-800 text-4xl font-semibold text-white">
          {item.title.slice(0, 1)}
        </div>
      )}
      <div className="mt-2 space-y-0.5">
        <p className="truncate text-sm font-medium text-white">{item.title}</p>
        <p className="text-xs text-zinc-400">
          {year}{' '}
          <span className="text-amber-400">★ {item.voteAverage.toFixed(1)}</span>
        </p>
      </div>
    </button>
  );
}
