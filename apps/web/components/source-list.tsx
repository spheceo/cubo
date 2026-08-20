import type { Stream } from '@cubo/core';
import { formatSize, streamKey } from '@/lib/stream-select';

export function SourceList({
  sources,
  activeKey,
  hiddenCount,
  onPick,
  onClose,
}: {
  sources: Stream[];
  activeKey: string | null;
  hiddenCount: number;
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  return (
    <aside
      className="fixed inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col border-l border-line bg-ink shadow-2xl"
      aria-label="Sources"
    >
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <p className="mb-1 text-[0.68rem] font-medium uppercase tracking-[0.1em] text-faint">
            Playback
          </p>
          <h2 className="text-base font-medium text-fg">Sources</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-full border border-line px-3 py-1.5 text-xs text-muted transition hover:border-line-strong hover:text-fg"
        >
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {sources.length === 0 ? (
          <p className="p-4 text-sm leading-relaxed text-muted">
            No browser-compatible sources were found for this title.
          </p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0">
            {sources.map((stream, index) => {
              const key = streamKey(stream);
              const active = key === activeKey;
              return (
                <li key={`${key}-${index}`}>
                  <button
                    type="button"
                    onClick={() => onPick(index)}
                    className={`w-full cursor-pointer rounded-xl px-3 py-3 text-left transition-colors ${
                      active ? 'bg-surface' : 'hover:bg-surface'
                    }`}
                  >
                    <span className="flex flex-wrap items-center gap-2 text-xs">
                      {stream.quality ? (
                        <span className="rounded bg-fg px-2 py-0.5 font-semibold text-ink">
                          {stream.quality}
                        </span>
                      ) : null}
                      <span className="rounded border border-line px-1.5 py-0.5 text-faint">MP4</span>
                      {stream.sizeBytes != null ? (
                        <span className="tabular-nums text-muted">{formatSize(stream.sizeBytes)}</span>
                      ) : null}
                      {stream.seeders != null ? (
                        <span className="tabular-nums text-muted">{stream.seeders} seeders</span>
                      ) : null}
                      {active ? <span className="ml-auto text-accent">Playing</span> : null}
                    </span>
                    <span className="mt-1.5 block truncate text-xs text-faint">
                      {stream.title.split('\n')[0]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {hiddenCount > 0 ? (
          <p className="px-3 pb-2 pt-4 text-[0.7rem] text-faint">
            {hiddenCount} incompatible MKV or HEVC sources hidden
          </p>
        ) : null}
      </div>
    </aside>
  );
}
