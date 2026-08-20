import { LibraryScreen } from '@/components/library-screen';
import { useDocumentTitle } from '@/lib/use-document-title';

export function LibraryPage() {
  useDocumentTitle('Library');
  return <LibraryScreen />;
}
