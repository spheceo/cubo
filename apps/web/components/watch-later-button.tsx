import type { WatchLaterItem } from '@cubo/core';
import gsap from 'gsap';
import { useRef, useState } from 'react';
import { IoAdd, IoCheckmark } from 'react-icons/io5';
import { useCore } from './core-provider';

export function WatchLaterButton({
  item,
  size = 'md',
}: {
  item: WatchLaterItem;
  size?: 'md' | 'lg';
}) {
  const core = useCore();
  const iconRef = useRef<HTMLDivElement>(null);
  const initiallySaved = core.library?.watchLater.some((entry) => entry.key === item.key) ?? false;
  const [pending, setPending] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const saved = optimistic ?? initiallySaved;

  const buttonSize = size === 'lg' ? 'h-14 w-14' : 'h-11 w-11';
  const iconSize = size === 'lg' ? 34 : 29;

  async function toggle() {
    const next = !saved;
    setOptimistic(next);
    setPending(true);

    gsap.fromTo(
      iconRef.current,
      { rotate: 0, scale: 0.8, opacity: 0.4 },
      { rotate: 360, scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(1.8)' },
    );

    try {
      await core.updateWatchLater(item, next);
    } catch {
      setOptimistic(saved);
      core.openSettings();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={pending}
      aria-pressed={saved}
      aria-label={
        saved ? `Remove ${item.title} from Watch later` : `Add ${item.title} to Watch later`
      }
      className={`flex ${buttonSize} cursor-pointer items-center justify-center rounded-full bg-control text-white transition-colors hover:bg-control-hover disabled:opacity-60`}
    >
      <div ref={iconRef}>
        {saved ? <IoCheckmark size={iconSize} /> : <IoAdd size={iconSize} />}
      </div>
    </button>
  );
}
