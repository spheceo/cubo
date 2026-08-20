import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { Link } from '@/components/link';
import { GearSix, MagnifyingGlass } from '@phosphor-icons/react';
import { useCore } from './core-provider';
import { SearchDialog } from './search-dialog';

const LINKS = [
  { href: '/', label: 'Home', mobile: true },
  { href: '/movies', label: 'Movies', mobile: false },
  { href: '/tv-shows', label: 'TV Shows', mobile: false },
  { href: '/library', label: 'Library', mobile: true },
];

export function SiteHeader() {
  const { connection, endpoint, openSettings } = useCore();
  const pathname = useLocation().pathname;
  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const coreConnected = connection !== null;

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-500 ${
        scrolled ? 'border-b border-line bg-black/72 backdrop-blur-xl' : 'border-b border-transparent'
      }`}
    >
      <div data-tauri-drag-region className="desktop-header-shell shell flex h-16 items-center justify-between">
        <Link
          href="/"
          aria-label="cubo home"
          className="text-[0.95rem] font-semibold tracking-[-0.04em] text-fg"
        >
          cubo<span className="text-accent">.</span>
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-4 sm:gap-6">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={pathname === link.href ? 'page' : undefined}
              className={`${link.mobile ? '' : 'hidden sm:block'} text-[0.78rem] transition-colors hover:text-fg ${
                pathname === link.href ? 'text-fg' : 'text-muted'
              }`}
            >
              {link.label}
            </Link>
          ))}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
            className="cursor-pointer rounded-full p-2 text-muted transition hover:bg-white/8 hover:text-fg"
          >
            <MagnifyingGlass className="size-[1.1rem]" weight="bold" />
          </button>
          <button
            type="button"
            onClick={openSettings}
            aria-label={coreConnected ? 'Core settings, connected' : endpoint ? 'Remote Core settings' : 'Core settings'}
            className="relative cursor-pointer rounded-full p-2 text-muted transition hover:bg-white/8 hover:text-fg"
          >
            <GearSix className="size-[1.1rem]" weight="bold" />
            <span className={`absolute right-1.5 top-1.5 size-1.5 rounded-full ring-2 ring-black ${coreConnected ? 'bg-accent' : 'bg-faint'}`} />
          </button>
        </nav>
      </div>
      {searchOpen ? <SearchDialog onClose={() => setSearchOpen(false)} /> : null}
    </header>
  );
}
