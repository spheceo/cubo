import {
  backdropUrl,
  posterUrl,
  profileUrl,
  watchHref,
  type Episode,
  type MediaDetails,
  type MediaSummary,
} from '@cubo/core';
import { Play } from '@phosphor-icons/react';
import { Link } from '@/components/link';
import { EpisodeList } from './episode-list';
import { MediaRow } from './media-row';
import { WatchLaterButton } from './watch-later-button';
import { AutoPreview } from './auto-preview';
import { watchLaterItem } from '@/lib/library';

function formatRuntime(minutes: number | null): string | null {
  if (!minutes) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h ${rest ? `${rest}m` : ''}`.trim() : `${rest}m`;
}

export function TitleDetail({
  details,
  recommendations,
  episodes,
}: {
  details: MediaDetails;
  recommendations: MediaSummary[];
  episodes: Episode[];
}) {
  const backdrop = backdropUrl(details.backdropPath, 'w1280');
  const poster = posterUrl(details.posterPath, 'w342');
  const year = details.releaseDate.slice(0, 4);
  const runtime = formatRuntime(details.runtime);
  const firstSeason = details.seasons[0]?.seasonNumber ?? 1;
  const playHref =
    details.mediaType === 'tv'
      ? watchHref(details, firstSeason, episodes[0]?.episodeNumber ?? 1)
      : watchHref(details);

  const meta = [
    year,
    details.mediaType === 'tv'
      ? details.numberOfSeasons
        ? `${details.numberOfSeasons} season${details.numberOfSeasons === 1 ? '' : 's'}`
        : null
      : runtime,
    details.voteAverage ? `${details.voteAverage.toFixed(1)} rating` : null,
  ].filter(Boolean);

  return (
    <main>
      <div className="relative isolate">
        {backdrop ? (
          <img
            src={backdrop}
            alt=""
            fetchPriority="high"
            className="absolute inset-x-0 top-0 -z-30 h-[26rem] w-full object-cover object-top sm:h-[34rem]"
          />
        ) : null}
        <AutoPreview
          item={details}
          videoClassName="absolute inset-x-0 top-0 -z-20 h-[26rem] w-full object-cover object-top sm:h-[34rem]"
          controlClassName="absolute right-5 top-[21rem] z-20 sm:right-8 sm:top-[29rem]"
        />
        <div className="absolute inset-x-0 top-0 -z-10 h-[26rem] bg-linear-to-t from-ink via-ink/80 to-ink/30 sm:h-[34rem]" />

        <div className="shell pt-28 pb-12 sm:pt-44 sm:pb-16">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:gap-10">
            {poster ? (
              <img
                src={poster}
                alt=""
                className="hidden w-44 shrink-0 rounded-xl ring-1 ring-line sm:block lg:w-52"
              />
            ) : null}

            <div className="min-w-0">
              <p className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted">
                {details.mediaType === 'tv' ? 'Series' : 'Film'}
              </p>
              <h1 className="mt-3 text-balance text-3xl font-semibold leading-[1.05] tracking-[-0.035em] text-fg sm:text-5xl lg:text-6xl">
                {details.title}
              </h1>
              {details.tagline ? (
                <p className="mt-3 max-w-xl text-sm italic text-muted">{details.tagline}</p>
              ) : null}

              <div className="mt-5 flex flex-wrap items-center gap-2.5 text-[0.8rem] tabular-nums text-muted">
                {meta.map((entry, index) => (
                  <span key={entry as string} className="flex items-center gap-2.5">
                    {index > 0 ? <span className="text-line-strong">·</span> : null}
                    {entry}
                  </span>
                ))}
              </div>

              {details.genres.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {details.genres.map((genre) => (
                    <span
                      key={genre}
                      className="rounded-full border border-line px-3 py-1 text-[0.72rem] text-muted"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Link
                  href={playHref}
                  className="inline-flex items-center gap-2 rounded-full bg-fg px-5 py-2.5 text-sm font-medium text-ink transition hover:bg-accent"
                >
                  <Play weight="fill" className="size-3" />
                  {details.mediaType === 'tv' ? 'Watch S1 E1' : 'Watch now'}
                </Link>
                <WatchLaterButton item={watchLaterItem(details)} />
                <Link
                  href={details.mediaType === 'tv' ? '/tv-shows' : '/movies'}
                  className="rounded-full border border-line px-5 py-2.5 text-sm font-medium text-muted transition hover:border-line-strong hover:text-fg"
                >
                  Back to browse
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="shell space-y-14 pb-24 sm:space-y-20">
        {details.overview ? (
          <section>
            <h2 className="text-base font-medium tracking-[-0.015em] text-fg sm:text-lg">
              Overview
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted sm:text-[0.95rem]">
              {details.overview}
            </p>
          </section>
        ) : null}

        {details.mediaType === 'tv' && details.seasons.length > 0 ? (
          <EpisodeList
            showId={details.id}
            seasons={details.seasons}
            initialSeason={firstSeason}
            initialEpisodes={episodes}
          />
        ) : null}

        {details.cast.length > 0 ? (
          <section>
            <h2 className="text-base font-medium tracking-[-0.015em] text-fg sm:text-lg">Cast</h2>
            <ul className="no-scrollbar -mx-5 mt-5 flex list-none gap-4 overflow-x-auto px-5 pb-1 sm:mx-0 sm:px-0">
              {details.cast.map((member) => {
                const image = profileUrl(member.profilePath);
                return (
                  <li key={member.id} className="w-24 shrink-0">
                    <div className="aspect-square overflow-hidden rounded-full bg-surface ring-1 ring-line">
                      {image ? (
                        <img
                          src={image}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : null}
                    </div>
                    <p className="mt-2.5 truncate text-[0.78rem] font-medium text-fg/85">
                      {member.name}
                    </p>
                    <p className="truncate text-[0.7rem] text-faint">{member.character}</p>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <MediaRow title="More like this" items={recommendations} />
      </div>
    </main>
  );
}
