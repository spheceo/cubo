import type { MediaDetails, MediaSummary } from '@cubo/core';
import { FeaturedHero } from './featured-hero';
import { MediaRow } from './media-row';
import { MotionReveal } from './motion-reveal';

export function CatalogLanding({
  featured,
  sections,
}: {
  featured: MediaDetails | null;
  sections: { title: string; items: MediaSummary[] }[];
}) {
  return (
    <main>
      {featured ? <FeaturedHero item={featured} /> : null}
      <div className="shell space-y-14 pb-28 pt-12 sm:space-y-20 sm:pt-16">
        {sections.map((section) => (
          <MotionReveal key={section.title}>
            <MediaRow title={section.title} items={section.items} />
          </MotionReveal>
        ))}
      </div>
    </main>
  );
}
