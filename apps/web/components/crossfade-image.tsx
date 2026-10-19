import { useEffect, useRef, useState } from 'react';

interface Layer {
  id: number;
  src: string;
}

const FADE_MS = 1000;
const SETTLE_MS = 2600;
const SETTLE_EASE = 'cubic-bezier(.22,1,.36,1)';

/** A full-bleed image that crossfades into its next `src`: the new picture
 *  fades in (settling from a slight zoom) over the old ones, which stay
 *  underneath until it fully covers them, so a swap never dips to black. */
export function CrossfadeImage({ src, className = '' }: { src: string; className?: string }) {
  const nextId = useRef(1);
  const [layers, setLayers] = useState<Layer[]>(() => (src ? [{ id: 0, src }] : []));

  useEffect(() => {
    if (!src) return;
    setLayers((current) => {
      if (current.at(-1)?.src === src) return current;
      return [...current, { id: nextId.current++, src }];
    });
  }, [src]);

  return (
    <div className={`absolute inset-0 isolate overflow-hidden ${className}`}>
      {layers.map((layer) => (
        <FadeLayer
          key={layer.id}
          src={layer.src}
          instant={layer.id === 0}
          // Once a picture covers the screen, everything under it goes.
          onShown={() => setLayers((current) => current.filter((entry) => entry.id >= layer.id))}
        />
      ))}
    </div>
  );
}

/**
 * One picture in the stack. It fades in only once it is decoded, with the
 * Web Animations API rather than a class flip: a picture already in cache
 * loads before the browser paints its starting frame, so a CSS transition
 * would skip straight to the end and pop in. Decoding first also keeps a
 * large still from stalling the fade halfway.
 */
function FadeLayer({
  src,
  instant,
  onShown,
}: {
  src: string;
  instant: boolean;
  onShown: () => void;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const shown = useRef(onShown);
  shown.current = onShown;

  useEffect(() => {
    const image = ref.current;
    if (!image) return;
    let cancelled = false;
    const animations: Animation[] = [];
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const reveal = () => {
      if (cancelled) return;
      if (instant || reduced) {
        image.style.opacity = '1';
        shown.current();
        return;
      }
      const fade = image.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: FADE_MS,
        easing: 'ease',
        fill: 'forwards',
      });
      animations.push(
        fade,
        image.animate([{ transform: 'scale(1.06)' }, { transform: 'scale(1)' }], {
          duration: SETTLE_MS,
          easing: SETTLE_EASE,
          fill: 'forwards',
        }),
      );
      fade.finished.then(() => !cancelled && shown.current()).catch(() => {});
    };

    const ready = image.complete && image.naturalWidth > 0
      ? image.decode()
      : new Promise<void>((resolve, reject) => {
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => reject(new Error('image failed')), { once: true });
        }).then(() => image.decode());
    // A failed or undecodable picture still takes its turn, so the stack
    // under it is not held forever.
    ready.then(reveal, reveal);

    return () => {
      cancelled = true;
      for (const animation of animations) animation.cancel();
    };
  }, [instant]);

  return (
    <img
      ref={ref}
      src={src}
      alt=""
      draggable={false}
      fetchPriority={instant ? 'high' : 'auto'}
      className="absolute inset-0 h-full w-full object-cover"
      style={{ opacity: 0 }}
    />
  );
}
