import { titleHref, type MediaSummary } from '@cubo/core';
import { SectionRow } from '@cubo/ui';
import { Link } from '@/components/link';

export function MediaRow({ title, items }: { title: string; items: MediaSummary[] }) {
  return (
    <SectionRow title={title} items={items} hrefFor={titleHref} linkComponent={Link} />
  );
}
