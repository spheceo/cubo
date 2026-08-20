import type { Episode, MediaDetails, MediaSummary, MediaType } from '@cubo/core';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { CatalogError } from '@/components/catalog-error';
import { TitleDetail } from '@/components/title-detail';
import { catalog } from '@/lib/api';
import { useDocumentTitle } from '@/lib/use-document-title';
import { NotFoundPage } from './not-found';

interface TitleData {
  details: MediaDetails;
  recommendations: MediaSummary[];
  episodes: Episode[];
}

export function TitlePage({ mediaType }: { mediaType: MediaType }) {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const valid = Number.isFinite(id);

  const [data, setData] = useState<TitleData | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useDocumentTitle(data?.details.title ?? null);

  useEffect(() => {
    if (!valid) {
      setMissing(true);
      return;
    }
    let cancelled = false;
    setData(null);
    setMissing(false);
    setError(null);
    (async () => {
      try {
        const [details, recommendations] = await Promise.all([
          catalog.tmdb.details(mediaType, id),
          catalog.tmdb.recommendations(mediaType, id),
        ]);
        let episodes: Episode[] = [];
        if (mediaType === 'tv') {
          const firstSeason = details.seasons[0]?.seasonNumber ?? 1;
          episodes = await catalog.tmdb.season(id, firstSeason);
        }
        if (!cancelled) setData({ details, recommendations, episodes });
      } catch (reason) {
        if (cancelled) return;
        const message = reason instanceof Error ? reason.message : '';
        if (message.includes('TMDB_API_KEY')) setError(message);
        else setMissing(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaType, id, valid]);

  if (error) return <CatalogError message={error} />;
  if (missing) return <NotFoundPage />;
  if (!data) return <TitleSkeleton />;

  return (
    <TitleDetail
      details={data.details}
      recommendations={data.recommendations}
      episodes={data.episodes}
    />
  );
}

function TitleSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="h-[26rem] bg-surface sm:h-[34rem]" />
      <div className="shell space-y-6 pb-24 pt-10">
        <div className="h-8 w-64 rounded bg-surface" />
        <div className="h-4 w-full max-w-2xl rounded bg-surface" />
        <div className="h-4 w-full max-w-xl rounded bg-surface" />
      </div>
    </div>
  );
}
