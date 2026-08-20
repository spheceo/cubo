import { Link } from '@/components/link';
import { useDocumentTitle } from '@/lib/use-document-title';

export function NotFoundPage() {
  useDocumentTitle('Not found');

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-white">
      <div className="max-w-sm text-center">
        <p className="text-xl font-semibold tracking-[-0.04em]">
          cubo<span className="text-accent">.</span>
        </p>
        <p className="mt-4 leading-relaxed text-white/60">That title could not be found.</p>
        <Link
          href="/"
          className="mt-8 inline-flex h-12 w-48 cursor-pointer items-center justify-center rounded-full bg-white font-semibold text-black"
        >
          Back to browse
        </Link>
      </div>
    </main>
  );
}
