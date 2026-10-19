import { IoAdd, IoPencil } from 'react-icons/io5';
import { Link } from '@/components/link';
import { useStreamingServices } from '@/lib/use-streaming-services';
import { ServiceTile } from './service-tile';

/** Home's "Your services": a brand tile per subscription, each opening that
 *  service's page. Hidden when the metadata source has no availability. */
export function ServicesRow({ className = '' }: { className?: string }) {
  const { all, services, loading, error } = useStreamingServices();

  if (error || (!loading && all.length === 0)) return null;

  return (
    <section className={className} aria-labelledby="services-heading">
      <div className="flex items-baseline gap-3">
        <h2 id="services-heading" className="text-2xl font-semibold">
          Your services
        </h2>
        <Link
          href="/library#services"
          className="ml-auto flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-muted transition-colors hover:text-white"
        >
          <IoPencil size={14} />
          Edit
        </Link>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {loading
          ? Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="aspect-[16/9] animate-pulse rounded-2xl bg-white/[0.06]" />
            ))
          : services.map((provider) => (
              <Link
                key={provider.id}
                href={`/services/${provider.id}`}
                aria-label={provider.name}
                className="group block cursor-pointer"
              >
                <ServiceTile
                  provider={provider}
                  className="aspect-[16/9] rounded-2xl transition-transform duration-500 ease-[cubic-bezier(.22,1,.36,1)] group-hover:-translate-y-1.5"
                />
                <p className="mt-2.5 truncate text-sm font-semibold">{provider.name}</p>
              </Link>
            ))}
        {!loading ? (
          <Link
            href="/library#services"
            className="flex aspect-[16/9] cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong text-sm font-semibold text-muted transition-colors hover:border-white/40 hover:text-white"
          >
            <IoAdd size={26} />
            {services.length ? 'Add a service' : 'Pick your services'}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
