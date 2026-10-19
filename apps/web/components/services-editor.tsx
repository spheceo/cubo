import { logoUrl } from '@cubo/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IoCheckmark, IoClose, IoSearch } from 'react-icons/io5';
import { tmdbQueries } from '@/lib/queries';
import { regionName } from '@/lib/streaming-services';
import { useStreamingServices } from '@/lib/use-streaming-services';
import { Dropdown } from './dropdown';

/** Pick the country and the services you subscribe to. Picks keep the order
 *  they were made in, which is the order Home shows them. */
export function ServicesEditor({ onClose }: { onClose: () => void }) {
  const current = useStreamingServices();
  const [region, setRegion] = useState(current.region);
  const [ids, setIds] = useState<number[]>(() => current.services.map((provider) => provider.id));
  const [filter, setFilter] = useState('');
  const providers = useQuery(tmdbQueries.providers(region));
  const regions = useQuery(tmdbQueries.providerRegions());
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  // The page behind a modal stays put.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previous;
    };
  }, []);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = providers.data ?? [];
    return needle ? list.filter((provider) => provider.name.toLowerCase().includes(needle)) : list;
  }, [providers.data, filter]);

  const regionOptions = (regions.data?.length ? regions.data : [{ code: region, name: regionName(region) }]).map(
    (entry) => ({ value: entry.code, label: entry.name }),
  );

  const toggle = (id: number) =>
    setIds((picked) => (picked.includes(id) ? picked.filter((entry) => entry !== id) : [...picked, id]));

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Your services"
        className="flex max-h-[min(44rem,90dvh)] w-full max-w-2xl flex-col rounded-2xl bg-panel text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-4 p-6 pb-4">
          <div>
            <h3 className="text-xl font-semibold">Your services</h3>
            <p className="mt-1 text-sm text-white/60">
              Pick the ones you subscribe to. Each gets a tile on Home.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="ml-auto flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/15"
          >
            <IoClose size={20} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 px-6 pb-4">
          <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-control px-4 text-sm">
            <IoSearch size={16} className="shrink-0 text-faint" />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Find a service"
              aria-label="Find a service"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
            />
          </label>
          {/* Last in the row: the panel opens leftward from its trigger. */}
          <Dropdown
            ariaLabel="Country"
            value={region}
            options={regionOptions}
            onChange={(value) => setRegion(value)}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-y border-line px-6 py-4">
          {providers.isLoading ? (
            <p className="py-8 text-center text-sm text-faint">Loading services…</p>
          ) : shown.length === 0 ? (
            <p className="py-8 text-center text-sm text-faint">
              {filter ? 'No service by that name here.' : `No services listed for ${regionName(region)}.`}
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {shown.map((provider) => {
                const on = ids.includes(provider.id);
                return (
                  <li key={provider.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(provider.id)}
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
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{provider.name}</span>
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
        </div>

        <div className="flex items-center gap-3 p-6 pt-4">
          <span className="text-sm text-faint">{ids.length} picked</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto cursor-pointer rounded-full bg-white/10 px-5 py-2 font-semibold transition-colors hover:bg-white/15"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              current.update({ region, ids });
              onClose();
            }}
            className="cursor-pointer rounded-full bg-white px-5 py-2 font-semibold text-black transition-colors hover:bg-white/85"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
