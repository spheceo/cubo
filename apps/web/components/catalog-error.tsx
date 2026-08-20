export function CatalogError({ message }: { message: string }) {
  const missingKey = message.includes('TMDB_API_KEY');

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <p className="text-[0.95rem] font-semibold tracking-[-0.04em] text-fg">
          cubo<span className="text-accent">.</span>
        </p>
        {missingKey ? (
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Add{' '}
            <code className="rounded bg-surface px-1.5 py-0.5 text-fg">TMDB_API_KEY</code> to{' '}
            <code className="rounded bg-surface px-1.5 py-0.5 text-fg">apps/web/.env.local</code>{' '}
            to load trending titles.
          </p>
        ) : (
          <>
            <p className="mt-4 text-sm leading-relaxed text-muted">{message}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 inline-block cursor-pointer rounded-full border border-line px-5 py-2.5 text-sm font-medium text-muted transition hover:border-line-strong hover:text-fg"
            >
              Try again
            </button>
          </>
        )}
      </div>
    </main>
  );
}
