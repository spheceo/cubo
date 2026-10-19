import type { MediaSummary } from '@cubo/core';
import type { LinkComponent } from './link';
import { MediaCard } from './media-card';
import { ScrollRow } from './scroll-row';

const CARD_WIDTH = 'w-[38vw] shrink-0 sm:w-[24vw] md:w-[14vw] xl:w-[11vw]';

export function SectionRow({
  title,
  items,
  hrefFor,
  linkComponent,
  limit = 12,
}: {
  title: string;
  items: MediaSummary[];
  hrefFor: (item: MediaSummary) => string;
  linkComponent?: LinkComponent;
  limit?: number;
}) {
  if (items.length === 0) return null;

  return (
    <section className="space-y-5">
      <h2 className="text-3xl font-bold">{title}</h2>

      <ScrollRow className="gap-3 pb-2">
        {items.slice(0, limit).map((item) => (
          <MediaCard
            key={`${item.mediaType}-${item.id}`}
            item={item}
            href={hrefFor(item)}
            linkComponent={linkComponent}
            className={CARD_WIDTH}
          />
        ))}
      </ScrollRow>
    </section>
  );
}
