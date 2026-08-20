'use client';

import type { MediaSummary } from '@cubo/core';
import { MediaCard } from './media-card';

export function SectionRow({
  title,
  items,
  onSelect,
}: {
  title: string;
  items: MediaSummary[];
  onSelect?: (item: MediaSummary) => void;
}) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-white">{title}</h2>
      <div className="flex gap-4 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => (
          <MediaCard key={`${item.mediaType}-${item.id}`} item={item} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}
