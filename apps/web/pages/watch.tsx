import type { MediaDetails, MediaType } from '@cubo/core';
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { WatchScreen } from '@/components/watch-screen';
import { catalog } from '@/lib/api';
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

  const [details, setDetails] = useState<MediaDetails | null>(null);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const resolvedSeason =
    mediaType === 'tv'
      ? Number(searchParams.get('season')) || details?.seasons[0]?.seasonNumber || 1
      : undefined;
  const resolvedEpisode = mediaType === 'tv' ? Number(searchParams.get('episode')) || 1 : undefined;

  useDocumentTitle(details ? `Watch ${details.title}` : 'Watch');

  useEffect(() => {
    if (!valid || !mediaType) {
      setMissing(true);
      return;
    }
    let cancelled = false;
    setDetails(null);
    setMissing(false);
    catalog.tmdb
      .details(mediaType, id)
      .then((found) => {
        if (!cancelled) setDetails(found);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaType, id, valid]);

  useEffect(() => {
    if (mediaType !== 'tv' || !details || resolvedSeason == null || resolvedEpisode == null) {
      setSubtitle(null);
      return;
    }
    let cancelled = false;
    catalog.tmdb
      .season(id, resolvedSeason)
      .then((episodes) => {
        if (cancelled) return;
        const current = episodes.find((entry) => entry.episodeNumber === resolvedEpisode);
        setSubtitle(
          `S${resolvedSeason} E${resolvedEpisode}${current?.name ? ` · ${current.name}` : ''}`,
        );
      })
      .catch(() => {
        if (!cancelled) setSubtitle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaType, id, details, resolvedSeason, resolvedEpisode]);

  if (missing) return <NotFoundPage />;
  if (!details || !mediaType) {
    return <div className="fixed inset-0 bg-black" aria-label="Loading player" />;
  }

  return (
    <WatchScreen
      key={`${mediaType}:${id}:${resolvedSeason ?? '-'}`}
      mediaType={mediaType}
      mediaId={id}
      imdbId={details.imdbId}
      title={details.title}
      subtitle={subtitle}
      backHref={`/${mediaType}/${id}`}
      backdropPath={details.backdropPath}
      posterPath={details.posterPath}
      logoPath={details.logoPath}
      season={resolvedSeason}
      episode={resolvedEpisode}
    />
  );
}
