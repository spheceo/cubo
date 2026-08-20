import type { MediaType } from '@cubo/core';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { CatalogError } from '@/components/catalog-error';
import { TitleSkeleton } from '@/components/page-skeletons';
import { TitleDetail } from '@/components/title-detail';
import { tmdbQueries } from '@/lib/queries';
import { useDocumentTitle } from '@/lib/use-document-title';
import { NotFoundPage } from './not-found';

export function TitlePage({ mediaType }: { mediaType: MediaType }) {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const valid = Number.isFinite(id);

  const details = useQuery({
    ...tmdbQueries.details(mediaType, id),
    enabled: valid,
  });
  const firstSeason = details.data?.seasons[0]?.seasonNumber ?? 1;
  const episodes = useQuery({
    ...tmdbQueries.season(id, firstSeason),
    enabled: valid && mediaType === 'tv' && details.data != null,
  });

  useDocumentTitle(details.data?.title ?? null);

  if (!valid) return <NotFoundPage />;
  if (details.error) {
    const message = details.error instanceof Error ? details.error.message : '';
    if (message.includes('TMDB_API_KEY')) return <CatalogError message={message} />;
    return <NotFoundPage />;
  }
  if (!details.data || (mediaType === 'tv' && episodes.isLoading)) {
    return <TitleSkeleton />;
  }

  return <TitleDetail details={details.data} episodes={episodes.data ?? []} />;
}
