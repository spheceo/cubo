import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { MediaGrid } from '@/components/media-grid';
import { MediaGridSkeleton } from '@/components/page-skeletons';
import { tmdbQueries } from '@/lib/queries';
import { useDocumentTitle } from '@/lib/use-document-title';

export function SearchPage() {
  useDocumentTitle('Search');
  const [params] = useSearchParams();
  const query = params.get('q')?.trim() ?? '';

  // Debounce keystrokes so mid-word queries never hit the network; cached
  // results still render instantly through the query cache.
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const results = useQuery({
    ...tmdbQueries.search(debounced),
    enabled: debounced.length > 0,
    placeholderData: keepPreviousData,
    select: (items) => items.filter((item) => item.posterPath || item.backdropPath),
  });

  const loading = query.length > 0 && (results.isLoading || debounced !== query);
  const items = results.data ?? [];

  return (
    <main className="min-h-dvh bg-background px-6 pb-16 pt-24 text-white sm:px-10">
      {loading && items.length === 0 ? (
        <MediaGridSkeleton />
      ) : query && items.length > 0 ? (
        <MediaGrid items={items} />
      ) : query && !loading ? (
        <p className="text-white/60">No results found.</p>
      ) : (
        <div className="h-px bg-white/10" />
      )}
    </main>
  );
}
