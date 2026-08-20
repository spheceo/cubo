'use client';

import { backdropUrl, type MediaSummary } from '@cubo/core';

export function Hero({
  item,
  onPlay,
}: {
  item: MediaSummary;
  onPlay?: (item: MediaSummary) => void;
}) {
  const src = backdropUrl(item.backdropPath, 'w1280');
  const year = item.releaseDate.slice(0, 4);

  return (
    <div className="relative min-h-[28rem] overflow-hidden bg-zinc-900">
      {src ? (
        <img
          src={src}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
      <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent" />
      <div className="relative flex min-h-[28rem] flex-col justify-end p-8">
        <h1 className="text-4xl font-bold text-white">{item.title}</h1>
        <p className="mt-3 line-clamp-3 max-w-2xl text-zinc-300">{item.overview}</p>
        <p className="mt-3 text-sm text-zinc-400">
          {year}{' '}
          <span className="text-amber-400">★ {item.voteAverage.toFixed(1)}</span>
        </p>
        <button
          type="button"
          className="mt-5 w-fit cursor-pointer rounded-full bg-amber-400 px-6 py-2.5 font-semibold text-black hover:bg-amber-300"
          onClick={() => onPlay?.(item)}
        >
          Play
        </button>
      </div>
    </div>
  );
}
