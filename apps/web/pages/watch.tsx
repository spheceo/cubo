import type { MediaType } from '@cubo/core';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import { WatchScreen } from '@/components/watch-screen';
import { tmdbQueries } from '@/lib/queries';
import { useDocumentTitle } from '@/lib/use-document-title';
import { NotFoundPage } from './not-found';

function parseMediaType(value: string | undefined): MediaType | null {
  return value === 'movie' || value === 'tv' ? value : null;
}

export function WatchPage() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const mediaType = parseMediaType(params.mediaType);
  const id = Number(params.id);
  const valid = mediaType !== null && Number.isFinite(id);

  const details = useQuery({
    ...tmdbQueries.details(mediaType ?? 'movie', id),
    enabled: valid,
  });

  const resolvedSeason =
    mediaType === 'tv'
      ? Number(searchParams.get('season')) || details.data?.seasons[0]?.seasonNumber || 1
      : undefined;
  const resolvedEpisode =
    mediaType === 'tv' ? Number(searchParams.get('episode')) || 1 : undefined;

  const season = useQuery({
    ...tmdbQueries.season(id, resolvedSeason ?? 1),
    enabled: valid && mediaType === 'tv' && details.data != null,
  });

  useDocumentTitle(details.data ? `Watch ${details.data.title}` : 'Watch');

  if (!valid || details.error) return <NotFoundPage />;
  if (!details.data || !mediaType) {
    return <div className="fixed inset-0 bg-black" aria-label="Loading player" />;
  }

  const currentEpisode =
    mediaType === 'tv'
      ? season.data?.find((entry) => entry.episodeNumber === resolvedEpisode)
      : undefined;
  const subtitle =
    mediaType === 'tv' && resolvedSeason != null && resolvedEpisode != null
      ? `S${resolvedSeason} E${resolvedEpisode}${currentEpisode?.name ? ` · ${currentEpisode.name}` : ''}`
      : null;

  return (
    <WatchScreen
      key={`${mediaType}:${id}:${resolvedSeason ?? '-'}`}
      mediaType={mediaType}
      mediaId={id}
      imdbId={details.data.imdbId}
      title={details.data.title}
      subtitle={subtitle}
      backHref={`/${mediaType}/${id}`}
      backdropPath={details.data.backdropPath}
      posterPath={details.data.posterPath}
      logoPath={details.data.logoPath}
      originalLanguage={details.data.originalLanguage}
      season={resolvedSeason}
      episode={resolvedEpisode}
    />
  );
}
