import { backdropUrl } from '@cubo/core';
import { Link } from '@/components/link';
import { useCore } from './core-provider';

export function HomeLibraryRail() {
  const { library } = useCore();
  const items = library?.history.filter((item) => item.positionSeconds >= 30 && item.progress < 0.9).slice(0, 6) ?? [];
  if (!items.length) return null;

  return (
    <section className="shell relative z-10 -mt-5 sm:-mt-8">
      <h2 className="mb-4 text-lg font-medium tracking-[-0.025em] text-white">Continue watching</h2>
      <div className="no-scrollbar -mx-5 flex gap-3 overflow-x-auto px-5 pb-2 sm:-mx-2 sm:px-2">
        {items.map((item) => {
          const image = backdropUrl(item.backdropPath, 'w780');
          return (
            <Link key={item.key} href={item.watchHref} className="group w-64 shrink-0 sm:w-72" aria-label={`Continue ${item.title}`}>
              <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-surface">
                {image ? <img src={image} alt="" className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.035]" /> : null}
                <div className="absolute inset-0 bg-linear-to-t from-black/90 via-black/5 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-4">
                  <p className="truncate text-sm font-medium text-white">{item.title}</p>
                  {item.subtitle ? <p className="mt-1 truncate text-[0.68rem] text-white/55">{item.subtitle}</p> : null}
                  <div className="mt-3 h-0.5 overflow-hidden rounded-full bg-white/20">
                    <div className="h-full bg-accent" style={{ width: `${item.progress * 100}%` }} />
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
