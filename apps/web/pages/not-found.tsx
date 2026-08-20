import { Link } from '@/components/link';
import { useDocumentTitle } from '@/lib/use-document-title';

export function NotFoundPage() {
  useDocumentTitle('Not found');
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <p className="text-[0.95rem] font-semibold tracking-[-0.04em] text-fg">
          cubo<span className="text-accent">.</span>
        </p>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          That title could not be found.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-full border border-line px-5 py-2.5 text-sm font-medium text-muted transition hover:border-line-strong hover:text-fg"
        >
          Back to browse
        </Link>
      </div>
    </main>
  );
}
