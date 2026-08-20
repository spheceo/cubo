import type { MediaDetails, MediaSummary, MediaType } from '@cubo/core';
import { ContinueWatching } from './continue-watching';
import { FeaturedHero } from './featured-hero';
import { MediaRow } from './media-row';
import { MotionReveal } from './motion-reveal';

export function CatalogLanding({
  mediaType,
  featured,
  sections,
}: {
  mediaType: MediaType;
  featured: MediaDetails | null;
  sections: { title: string; items: MediaSummary[] }[];
}) {
  return (
    <div className="min-h-dvh bg-background text-white">
      {featured ? <FeaturedHero item={featured} /> : null}

      <div className="relative space-y-10 px-6 sm:px-10">
        <ContinueWatching mediaType={mediaType} className="pt-2" />
        {sections.map((section) => (
          <MotionReveal key={section.title}>
            <MediaRow title={section.title} items={section.items} />
          </MotionReveal>
        ))}
      </div>
    </div>
  );
}
