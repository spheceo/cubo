import { Link } from '@/components/link';
import { useCore } from './core-provider';

export function SiteFooter() {
  const { connection, openSettings } = useCore();

  return (
    <footer className="flex flex-wrap items-center gap-6 px-6 py-10 text-sm text-white/35 sm:px-10">
      <button
        type="button"
        onClick={openSettings}
        className="cursor-pointer border-0 bg-transparent p-0 text-sm text-white/35 transition-colors hover:text-white/60"
      >
        Core
      </button>
      <Link href="/library" className="cursor-pointer transition-colors hover:text-white/60">
        Library
      </Link>
      <Link href="/legal" className="cursor-pointer transition-colors hover:text-white/60">
        Legal
      </Link>
      {connection?.version ? (
        <span className="ml-auto tabular-nums">v{connection.version.replace(/^v/, '')}</span>
      ) : null}
    </footer>
  );
}
