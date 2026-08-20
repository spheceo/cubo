import type { MediaSummary } from '@cubo/core';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { MediaGrid } from '@/components/media-grid';
import { catalog } from '@/lib/api';
import { useDocumentTitle } from '@/lib/use-document-title';

export function SearchPage() {
  useDocumentTitle('Search');
  const [params] = useSearchParams();
  const query = params.get('q')?.trim() ?? '';
  const [results, setResults] = useState<MediaSummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    catalog.tmdb
      .search(query)
      .then((items) => {
        if (!cancelled) {
          setResults(items.filter((item) => item.posterPath || item.backdropPath));
        }
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  return (
    <main className="shell min-h-[72vh] pb-28 pt-28 sm:pt-32">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-faint">Search</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em] text-fg sm:text-6xl">
        {query ? `“${query}”` : 'Find something to watch'}
      </h1>
      <p className="mt-4 text-sm text-muted">
        {query
          ? loading
            ? 'Searching the catalogue…'
            : `${results.length} matches across movies and series`
          : 'Use the search button above to explore the catalogue.'}
      </p>
      <div className="mt-10">
        <MediaGrid items={results} />
      </div>
    </main>
  );
}
