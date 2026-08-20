import { useLocation } from 'react-router';
import { Link } from '@/components/link';
import { CuboWordmark } from './cubo-logo';
import { NavSearch } from './nav-search';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/movies', label: 'Movies' },
  { href: '/tv-shows', label: 'TV Shows' },
  { href: '/library', label: 'Library' },
];

export function SiteHeader() {
  const { pathname } = useLocation();

  return (
    <div className="absolute top-0 z-50 w-full">
      <div className="pointer-events-none fixed inset-x-0 top-0 z-0 h-24 bg-linear-to-b from-[#141414e6] via-[#14141499] to-transparent [mask-image:linear-gradient(to_bottom,black_0%,black_70%,transparent_100%)]" />

      <header className="relative z-10">
        <nav
          aria-label="Primary"
          data-tauri-drag-region
          className="desktop-header-shell relative z-10 flex h-16 items-center gap-5 px-6 sm:gap-8 sm:px-10"
        >
          <Link
            href="/"
            aria-label="cubo home"
            className="shrink-0 text-xl font-semibold text-fg"
          >
            <CuboWordmark />
          </Link>

          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={pathname === link.href ? 'page' : undefined}
              className={`font-semibold ${
                pathname === link.href
                  ? 'cursor-default text-white'
                  : 'text-muted hover:text-white'
              } ${link.href === '/movies' || link.href === '/tv-shows' || link.href === '/library' ? 'hidden sm:block' : ''}`}
            >
              {link.label}
            </Link>
          ))}

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <NavSearch />
          </div>
        </nav>
      </header>
    </div>
  );
}
