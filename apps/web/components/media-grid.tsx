import { titleHref, type MediaSummary } from '@cubo/core';
import { MediaCard } from '@cubo/ui';
import { Link } from '@/components/link';

export function MediaGrid({ items }: { items: MediaSummary[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
      {items.map((item) => (
        <MediaCard
          key={`${item.mediaType}-${item.id}`}
          item={item}
          href={titleHref(item)}
          linkComponent={Link}
          className="w-full sm:w-full"
        />
      ))}
    </div>
  );
}
