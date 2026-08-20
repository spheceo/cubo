import { CuboWordmark } from './cubo-logo';

export function CatalogError({ message }: { message: string }) {
  const missingKey = message.includes('TMDB_API_KEY');

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-white">
      <div className="max-w-sm text-center">
        <p className="text-xl font-semibold">
          <CuboWordmark className="justify-center" />
        </p>
        {missingKey ? (
          <p className="mt-4 leading-relaxed text-white/60">
            Add <code className="rounded bg-surface px-1.5 py-0.5 text-white">TMDB_API_KEY</code> to{' '}
            <code className="rounded bg-surface px-1.5 py-0.5 text-white">apps/web/.env.local</code>{' '}
            to load trending titles.
          </p>
        ) : (
          <>
            <p className="mt-4 leading-relaxed text-white/60">{message}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-8 inline-flex h-12 w-48 cursor-pointer items-center justify-center rounded-full bg-white font-semibold text-black"
            >
              Try again
            </button>
          </>
        )}
      </div>
    </main>
  );
}
