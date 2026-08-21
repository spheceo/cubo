import { titleHref } from '@cubo/core';
import { MediaCard } from '@cubo/ui';
import { Link } from '@/components/link';
import { asMediaSummary } from '@/lib/format';
import { useCore } from './core-provider';

export function WatchLaterList({ className = 'mt-8' }: { className?: string }) {
  const { library } = useCore();
  const items = (library?.watchLater ?? []).slice(0, 8);

  if (items.length === 0) return null;

  return (
    <section className={className}>
      <h2 className="text-2xl font-semibold">Watch Later</h2>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
        {items.map((item) => {
          const summary = asMediaSummary(item);
          return (
            <MediaCard
              key={item.key}
              item={summary}
              href={item.detailHref || titleHref(summary)}
              linkComponent={Link}
              className="w-full"
            />
          );
        })}
      </div>
    </section>
  );
}
