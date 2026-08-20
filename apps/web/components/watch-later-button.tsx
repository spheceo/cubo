import type { WatchLaterItem } from '@cubo/core';
import { Check, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { useCore } from './core-provider';

export function WatchLaterButton({
  item,
  iconOnly = false,
}: {
  item: WatchLaterItem;
  iconOnly?: boolean;
}) {
  const core = useCore();
  const initiallySaved = core.library?.watchLater.some((entry) => entry.key === item.key) ?? false;
  const [pending, setPending] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const saved = optimistic ?? initiallySaved;

  async function toggle() {
    const next = !saved;
    setOptimistic(next);
    setPending(true);
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
      aria-label={saved ? `Remove ${item.title} from Watch later` : `Add ${item.title} to Watch later`}
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-full border border-line-strong bg-black/25 text-sm font-medium text-fg/90 backdrop-blur-md transition hover:border-fg/55 hover:bg-white/8 disabled:opacity-60 ${iconOnly ? 'size-11' : 'px-5 py-2.5'}`}
    >
      {saved ? <Check weight="bold" className="size-4" /> : <Plus weight="bold" className="size-4" />}
      {!iconOnly ? (saved ? 'Saved' : 'Watch later') : null}
    </button>
  );
}
