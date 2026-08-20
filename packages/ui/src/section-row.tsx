import type { MediaSummary } from '@cubo/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IoChevronBack, IoChevronForward } from 'react-icons/io5';
import type { LinkComponent } from './link';
import { MediaCard } from './media-card';

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
  const scroller = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const sync = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', sync);
      observer.disconnect();
    };
  }, [sync]);

  function page(direction: 'left' | 'right') {
    const el = scroller.current;
    if (!el) return;
    const amount = el.clientWidth * 0.75;
    el.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' });
  }

  if (items.length === 0) return null;

  return (
    <section className="space-y-5">
      <h2 className="text-3xl font-bold">{title}</h2>

      <div className="group/row relative">
        <ScrollEdge direction="left" enabled={canScrollLeft} onClick={page} />

        <div ref={scroller} className="no-scrollbar flex gap-3 overflow-x-auto pb-2">
          {items.slice(0, limit).map((item) => (
            <MediaCard
              key={`${item.mediaType}-${item.id}`}
              item={item}
              href={hrefFor(item)}
              linkComponent={linkComponent}
              className={CARD_WIDTH}
            />
          ))}
        </div>

        <ScrollEdge direction="right" enabled={canScrollRight} onClick={page} />
      </div>
    </section>
  );
}

function ScrollEdge({
  direction,
  enabled,
  onClick,
}: {
  direction: 'left' | 'right';
  enabled: boolean;
  onClick: (direction: 'left' | 'right') => void;
}) {
  const left = direction === 'left';

  return (
    <button
      type="button"
      aria-label={left ? 'Scroll left' : 'Scroll right'}
      onClick={() => onClick(direction)}
      className={`absolute top-0 z-10 hidden h-full w-28 cursor-pointer items-center transition-opacity duration-200 md:flex ${
        left ? '-left-4 justify-start pl-1' : '-right-4 justify-end pr-1'
      } ${enabled ? 'opacity-0 group-hover/row:opacity-100' : 'pointer-events-none opacity-0'}`}
      style={{
        background: `linear-gradient(to ${left ? 'right' : 'left'}, var(--color-background) 30%, transparent)`,
      }}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/[0.08] text-white backdrop-blur-sm transition-colors hover:bg-white/[0.14]">
        {left ? <IoChevronBack size={18} /> : <IoChevronForward size={18} />}
      </span>
    </button>
  );
}
