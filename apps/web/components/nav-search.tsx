import gsap from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { IoSearch } from 'react-icons/io5';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

/** The header search pill: a plain icon that expands into a field, mirroring
 *  Kino's navbar. Typing navigates straight to the results page. */
export function NavSearch() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery(searchParams.get('q') ?? '');
  }, [searchParams]);

  useEffect(() => {
    const container = containerRef.current;
    const input = inputRef.current;
    if (!container || !input) return;

    gsap.to(container, {
      width: isOpen ? 272 : 40,
      backgroundColor: isOpen ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0)',
      borderColor: isOpen ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0)',
      duration: 0.35,
      ease: 'power3.out',
      onComplete: () => {
        if (isOpen) input.focus();
      },
    });

    gsap.to(input, {
      autoAlpha: isOpen ? 1 : 0,
      duration: isOpen ? 0.2 : 0.12,
      ease: 'power2.out',
    });

    return () => {
      gsap.killTweensOf([container, input]);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [isOpen]);

  return (
    <div className="relative z-50 flex items-center">
      <div
        ref={containerRef}
        className={`flex h-10 w-10 items-center overflow-hidden rounded-full border border-transparent ${
          isOpen ? 'cursor-text backdrop-blur-sm' : 'cursor-pointer'
        }`}
      >
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-white transition-colors hover:text-white/70"
          aria-label={isOpen ? 'Close search' : 'Open search'}
          aria-expanded={isOpen}
        >
          <IoSearch size={isOpen ? 21 : 24} />
        </button>
        <input
          ref={inputRef}
          type="text"
          placeholder="Titles, people, genres"
          value={query}
          className="invisible min-w-0 flex-1 bg-transparent pr-4 text-sm text-white opacity-0 outline-none placeholder:text-white/50"
          onChange={(event) => {
            const value = event.target.value;
            setQuery(value);
            if (value.trim()) {
              // Only the first keystroke adds a history entry, so clearing the
              // field returns to whatever the viewer was browsing before.
              navigate(`/search?q=${encodeURIComponent(value)}`, {
                replace: pathname === '/search',
              });
            } else if (pathname === '/search') {
              navigate(-1);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setIsOpen(false);
          }}
          tabIndex={isOpen ? 0 : -1}
        />
      </div>
    </div>
  );
}
