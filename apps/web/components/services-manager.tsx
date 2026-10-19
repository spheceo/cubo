import { logoUrl, type WatchProvider } from '@cubo/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { IoCheckmark, IoSearch } from 'react-icons/io5';
import { useLocation } from 'react-router';
import { tmdbQueries } from '@/lib/queries';
import { regionName } from '@/lib/streaming-services';
import { useStreamingServices } from '@/lib/use-streaming-services';
import { Dropdown } from './dropdown';

/** How many services list before "Show all"; TMDB knows hundreds. */
const COLLAPSED_COUNT = 24;

/**
 * Library's "Your services": the subscriptions that get a tile on Home, in
 * the order they were picked, from every service TMDB lists in any country.
 * The country only orders things (its services list first, service pages
 * rank by it). Changes save as they are made.
 */
export function ServicesManager() {
  const { region, all, services, loading, error, update } = useStreamingServices();
  const regions = useQuery(tmdbQueries.providerRegions());
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const { hash } = useLocation();

  // Home's Edit links here. The Library fills in above this section after
  // Core answers, so the browser's own jump misses it: hold the section in
  // view while the page settles, until the viewer scrolls for themselves.
  useEffect(() => {
    if (hash !== '#services') return;
    const section = sectionRef.current;
    if (!section) return;
    const pin = () => section.scrollIntoView({ block: 'start' });
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(document.body);
    const release = () => observer.disconnect();
    const timer = window.setTimeout(release, 2500);
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    for (const name of events) window.addEventListener(name, release, { once: true, passive: true });
    return () => {
      window.clearTimeout(timer);
      release();
      for (const name of events) window.removeEventListener(name, release);
    };
  }, [hash]);

  const pickedIds = services.map((provider) => provider.id);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle) return all.filter((provider) => provider.name.toLowerCase().includes(needle));
    // Picked ones lead so they stay in reach when the list is collapsed.
    const rest = all.filter((provider) => !pickedIds.includes(provider.id));
    const list = [...services, ...rest];
    return expanded ? list : list.slice(0, COLLAPSED_COUNT);
    // `pickedIds` follows `services`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, services, filter, expanded]);

  const toggle = (provider: WatchProvider) =>
    update({
      region,
      ids: pickedIds.includes(provider.id)
        ? pickedIds.filter((id) => id !== provider.id)
        : [...pickedIds, provider.id],
    });

  const regionOptions = (
    regions.data?.length ? regions.data : [{ code: region, name: regionName(region) }]
  ).map((entry) => ({ value: entry.code, label: entry.name }));

  if (error) return null;

  return (
    <section ref={sectionRef} id="services" className="scroll-mt-24">
      <div className="flex flex-wrap items-end gap-4">
        <div className="mr-auto">
          <h2 className="text-2xl font-semibold">Your services</h2>
          <p className="mt-1 text-sm text-faint">
            Each one gets a tile on Home. {services.length} picked.
          </p>
        </div>
        <label className="flex h-10 w-full items-center gap-2 rounded-full bg-control px-4 text-sm sm:w-64">
          <IoSearch size={16} className="shrink-0 text-faint" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a service"
            aria-label="Find a service"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
          />
        </label>
        <div className="flex items-center gap-2 text-sm text-faint">
          Rank by
          {/* Last in the row: the panel opens leftward from its trigger. */}
          <Dropdown
            ariaLabel="Country"
            value={region}
            options={regionOptions}
            onChange={(value) => update({ region: value, ids: pickedIds })}
          />
        </div>
      </div>

      {loading ? (
        <p className="mt-6 text-sm text-faint">Loading services…</p>
      ) : shown.length === 0 ? (
        <p className="mt-6 text-sm text-faint">No service by that name.</p>
      ) : (
        <ul className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((provider) => {
            const on = pickedIds.includes(provider.id);
            const local = provider.priorities[region] != null;
            return (
              <li key={provider.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(provider)}
                  className={`flex w-full cursor-pointer items-center gap-3 rounded-xl p-2 text-left transition-colors ${
                    on ? 'bg-white/[0.12]' : 'hover:bg-white/[0.06]'
                  }`}
                >
                  {provider.logoPath ? (
                    <img
                      src={logoUrl(provider.logoPath, 'w300')}
                      alt=""
                      loading="lazy"
                      className="h-10 w-10 shrink-0 rounded-lg"
                    />
                  ) : (
                    <span className="h-10 w-10 shrink-0 rounded-lg bg-control" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{provider.name}</span>
                    {!local ? (
                      <span className="block truncate text-xs text-faint">
                        Not in {regionName(region)}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                      on ? 'bg-white text-black' : 'border border-line-strong'
                    }`}
                  >
                    {on ? <IoCheckmark size={14} /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!filter && !loading && all.length > COLLAPSED_COUNT ? (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="mt-4 cursor-pointer text-sm font-semibold text-muted transition-colors hover:text-white"
        >
          {expanded ? 'Show fewer' : `Show all ${all.length.toLocaleString()} services`}
        </button>
      ) : null}
    </section>
  );
}
