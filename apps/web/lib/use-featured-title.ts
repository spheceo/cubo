import type { MediaSummary } from '@cubo/core';
import { useEffect, useRef, useState } from 'react';
import { nextFeatured } from './featured-selection';

/** Resolve on page entry, never during query refreshes or ordinary rerenders. */
export function useFeaturedTitle(scope: string, candidates: MediaSummary[] | null): MediaSummary | null | undefined {
  const selected = useRef<{ scope: string; item: MediaSummary | null } | null>(null);
  const [selection, setSelection] = useState<typeof selected.current>(null);
  useEffect(() => {
    if (!candidates || selected.current?.scope === scope) return;
    const next = { scope, item: nextFeatured(candidates, scope) };
    selected.current = next;
    setSelection(next);
  }, [scope, candidates]);
  return selection?.scope === scope ? selection.item : undefined;
}
