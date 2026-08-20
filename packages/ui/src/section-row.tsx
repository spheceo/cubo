import type { MediaSummary } from '@cubo/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LinkComponent } from './link';
import { MediaCard } from './media-card';

export function SectionRow({
  title,
  items,
  hrefFor,
  linkComponent,
}: {
  title: string;
  items: MediaSummary[];
  hrefFor: (item: MediaSummary) => string;
  linkComponent?: LinkComponent;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const sync = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [sync, items]);

  function page(direction: -1 | 1) {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: 'smooth' });
  }

  if (items.length === 0) return null;

  return (
    <section className="group/row">
      <div className="mb-4 flex items-center justify-between gap-4 sm:mb-5">
        <h2 className="text-base font-medium tracking-[-0.015em] text-fg sm:text-lg">
          {title}
        </h2>
        <div className="hidden items-center gap-1.5 opacity-0 transition-opacity duration-200 group-hover/row:opacity-100 focus-within:opacity-100 sm:flex">
          <ScrollButton direction={-1} disabled={atStart} onClick={page} />
          <ScrollButton direction={1} disabled={atEnd} onClick={page} />
        </div>
      </div>

      <div className="relative">
        <div
          ref={scroller}
          onScroll={sync}
          className="no-scrollbar -mx-5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-3 sm:-mx-2 sm:gap-4 sm:px-2"
        >
          {items.map((item) => (
            <div key={`${item.mediaType}-${item.id}`} className="snap-start">
              <MediaCard item={item} href={hrefFor(item)} linkComponent={linkComponent} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ScrollButton({
  direction,
  disabled,
  onClick,
}: {
  direction: -1 | 1;
  disabled: boolean;
  onClick: (direction: -1 | 1) => void;
}) {
  return (
    <button
      type="button"
      aria-label={direction === -1 ? 'Scroll left' : 'Scroll right'}
      disabled={disabled}
      onClick={() => onClick(direction)}
      className="flex size-8 cursor-pointer items-center justify-center rounded-full border border-line text-muted transition hover:border-line-strong hover:text-fg disabled:cursor-default disabled:opacity-25 disabled:hover:border-line disabled:hover:text-muted"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`size-3.5 ${direction === -1 ? 'rotate-180' : ''}`}
      >
        <path d="M6 3.5 10.5 8 6 12.5" />
      </svg>
    </button>
  );
}
