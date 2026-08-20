import { Link } from '@/components/link';
import { useCore } from './core-provider';

export function SiteFooter() {
  const { connection, openSettings } = useCore();
  const currentYear = new Date().getFullYear();

  return (
    <footer className="flex flex-wrap items-center gap-6 px-6 py-10 text-sm text-white/35 sm:px-10">
      <span>&copy; {currentYear} Cubo</span>
      <Link href="/library" className="cursor-pointer transition-colors hover:text-white/60">
        Library
      </Link>
      <button
        type="button"
        onClick={openSettings}
        className="flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-sm text-white/35 transition-colors hover:text-white/60"
      >
        Core settings
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full ${connection ? 'bg-accent' : 'bg-faint'}`}
        />
      </button>
      <Link href="/legal" className="cursor-pointer transition-colors hover:text-white/60">
        Legal
      </Link>
    </footer>
  );
}
