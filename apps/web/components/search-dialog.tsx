import { posterUrl, titleHref, type MediaSummary } from '@cubo/core';
import { useGSAP } from '@gsap/react';
import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { gsap } from 'gsap';
import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Link } from '@/components/link';
import { catalog } from '@/lib/api';

gsap.registerPlugin(useGSAP);

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closingRef = useRef(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim());
  const [results, setResults] = useState<MediaSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose();
      return;
    }
    gsap.timeline({ onComplete: onClose })
      .to(dialogRef.current, { autoAlpha: 0, y: -18, scale: 0.99, duration: 0.25, ease: 'power2.in' })
      .to(overlayRef.current, { autoAlpha: 0, duration: 0.2, ease: 'power1.out' }, '<0.06');
  }, [onClose]);

  useGSAP(() => {
    const overlay = overlayRef.current;
    const dialog = dialogRef.current;
    if (!overlay || !dialog) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      gsap.set([overlay, dialog], { autoAlpha: 1, clearProps: 'transform' });
      return;
    }
    gsap.set(overlay, { autoAlpha: 0 });
    gsap.set(dialog, { autoAlpha: 0, y: -28, scale: 0.985 });
    gsap.timeline()
      .to(overlay, { autoAlpha: 1, duration: 0.35, ease: 'power1.out' })
      .to(dialog, { autoAlpha: 1, y: 0, scale: 1, duration: 0.58, ease: 'power3.out' }, '<0.06');
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  useEffect(() => {
    if (deferredQuery.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void catalog.tmdb.search(deferredQuery)
        .then((items) => {
          if (!cancelled) setResults(items.filter((item) => item.posterPath).slice(0, 12));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deferredQuery]);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/88 px-3 pb-3 pt-3 backdrop-blur-xl sm:px-6 sm:pb-6 sm:pt-6 lg:px-10 lg:pt-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      role="presentation"
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search movies and TV shows"
        className="flex max-h-[calc(100dvh-1.5rem)] min-h-[min(42rem,calc(100dvh-1.5rem))] w-full max-w-[88rem] flex-col overflow-hidden rounded-[1.5rem] border border-white/12 bg-[#070709]/92 shadow-[0_30px_100px_rgba(0,0,0,0.75)] backdrop-blur-2xl sm:max-h-[calc(100dvh-3rem)] sm:min-h-[min(44rem,calc(100dvh-3rem))] sm:rounded-[2rem]"
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const value = query.trim();
            if (!value) return;
            onClose();
            navigate(`/search?q=${encodeURIComponent(value)}`);
          }}
        >
          <div className="flex items-center gap-3 border-b border-white/14 px-5 py-5 sm:gap-5 sm:px-8 sm:py-7 lg:px-10">
            <MagnifyingGlass className="size-6 shrink-0 text-white/48 sm:size-7" />
            <input
              ref={inputRef}
              name="q"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search movies and shows"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-2xl font-medium tracking-[-0.035em] text-white outline-none placeholder:text-white/24 sm:text-4xl"
            />
            <button
              type="button"
              onClick={close}
              aria-label="Close search"
              className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-white/10 text-white/55 transition hover:border-white/20 hover:bg-white/8 hover:text-white"
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8 sm:py-8 lg:px-10">
            {loading ? <p className="text-sm text-white/40">Searching…</p> : null}
            {!loading && deferredQuery.length >= 2 && results.length === 0 ? (
              <p className="text-sm text-white/40">No matches yet.</p>
            ) : null}
            {results.length ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-4 sm:gap-x-4 lg:grid-cols-6">
                {results.map((item) => {
                  const image = posterUrl(item.posterPath, 'w342');
                  return (
                    <Link key={`${item.mediaType}-${item.id}`} href={titleHref(item)} onClick={close} className="group min-w-0">
                      <div className="aspect-[2/3] overflow-hidden rounded-xl border border-white/10 bg-white/5 sm:rounded-2xl">
                        {image ? <img src={image} alt="" className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.035]" /> : null}
                      </div>
                      <p className="mt-2.5 truncate text-xs font-medium text-white/82">{item.title}</p>
                      <p className="mt-1 text-[0.68rem] text-white/35">{item.mediaType === 'tv' ? 'Series' : 'Film'}</p>
                    </Link>
                  );
                })}
              </div>
            ) : null}
            {deferredQuery.length >= 2 ? (
              <button type="submit" className="mt-8 cursor-pointer text-xs font-medium text-accent transition hover:text-white">
                See all results for “{deferredQuery}”
              </button>
            ) : (
              <div className="flex min-h-56 items-center justify-center">
                <p className="text-sm text-white/32">Start typing to search the full catalogue.</p>
              </div>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
