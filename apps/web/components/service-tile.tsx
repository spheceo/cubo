import { logoUrl, type WatchProvider } from '@cubo/core';
import { useEffect, useState } from 'react';

const colors = new Map<string, string | null>();

/** The colour a provider logo sits on, read from its corner pixel, so a tile
 *  can extend the logo edge to edge in the service's own brand colour. */
export function useLogoColor(src: string): string | null {
  const [color, setColor] = useState(() => colors.get(src) ?? null);

  useEffect(() => {
    if (!src) return;
    if (colors.has(src)) {
      setColor(colors.get(src) ?? null);
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    // Its own cache entry: the same logo shown elsewhere was fetched without
    // CORS, and the browser would reuse that copy and refuse to read it.
    image.onload = () => {
      let sampled: string | null = null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d');
        context?.drawImage(image, 2, 2, 1, 1, 0, 0, 1, 1);
        const pixel = context?.getImageData(0, 0, 1, 1).data;
        if (pixel) sampled = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
      } catch {
        // A tainted canvas (no CORS) just keeps the neutral tile.
      }
      colors.set(src, sampled);
      if (!cancelled) setColor(sampled);
    };
    image.onerror = () => colors.set(src, null);
    image.src = `${src}?sample`;
    return () => {
      cancelled = true;
    };
  }, [src]);

  return color;
}

/** A service's logo filling a tile of its brand colour; the logo's square
 *  edge is feathered into the tile so it reads as one surface. */
export function ServiceTile({
  provider,
  className = '',
}: {
  provider: WatchProvider;
  className?: string;
}) {
  const src = logoUrl(provider.logoPath, 'w300');
  const color = useLogoColor(src);

  return (
    <div
      className={`flex items-center justify-center overflow-hidden bg-surface shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] transition-colors duration-500 ${className}`}
      style={color ? { backgroundColor: color } : undefined}
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="aspect-square h-full object-contain [mask-image:radial-gradient(circle,#000_52%,transparent_71%)]"
        />
      ) : (
        <span className="px-4 text-center text-lg font-semibold">{provider.name}</span>
      )}
    </div>
  );
}
