import { useEffect, useRef, useState } from 'react';

interface Layer {
  id: number;
  src: string;
}

/** A full-bleed image that crossfades into its next `src`: the new picture
 *  fades in (settling from a slight zoom) over the old one, which is only
 *  dropped once covered, so a swap never dips to black. */
export function CrossfadeImage({ src, className = '' }: { src: string; className?: string }) {
  const nextId = useRef(1);
  const [layers, setLayers] = useState<Layer[]>(() => (src ? [{ id: 0, src }] : []));

  useEffect(() => {
    if (!src) return;
    setLayers((current) => {
      if (current.at(-1)?.src === src) return current;
      // Two at most: a quick run of swaps fades the newest over the last.
      return [...current.slice(-1), { id: nextId.current++, src }];
    });
  }, [src]);

  return (
    <div className={`absolute inset-0 isolate overflow-hidden ${className}`}>
      {layers.map((layer) => (
        <FadeLayer
          key={layer.id}
          src={layer.src}
          instant={layer.id === 0}
          onShown={() => setLayers((current) => current.filter((entry) => entry.id >= layer.id))}
        />
      ))}
    </div>
  );
}

function FadeLayer({
  src,
  instant,
  onShown,
}: {
  src: string;
  instant: boolean;
  onShown: () => void;
}) {
  const [loaded, setLoaded] = useState(instant);

  return (
    <img
      src={src}
      alt=""
      fetchPriority={instant ? 'high' : 'auto'}
      onLoad={() => {
        setLoaded(true);
        if (instant) onShown();
      }}
      onTransitionEnd={(event) => {
        if (event.propertyName === 'opacity' && loaded) onShown();
      }}
      className={`absolute inset-0 h-full w-full object-cover motion-safe:transition-[opacity,transform] motion-safe:duration-[1000ms,2600ms] motion-safe:ease-[ease,cubic-bezier(.22,1,.36,1)] ${
        loaded ? 'scale-100 opacity-100' : 'scale-[1.06] opacity-0'
      }`}
    />
  );
}
