import type { Stream } from '@cubo/core';
import { Check, X } from '@phosphor-icons/react';
import type { PlayerSubtitle } from './video-player';
import { formatSize, streamKey } from '@/lib/stream-select';

export function PlayerSettings({
  sources,
  activeKey,
  hiddenCount,
  subtitles,
  activeSubtitleId,
  onPickSource,
  onPickSubtitle,
  onClose,
}: {
  sources: Stream[];
  activeKey: string | null;
  hiddenCount: number;
  subtitles: PlayerSubtitle[];
  activeSubtitleId: string | null;
  onPickSource: (index: number) => void;
  onPickSubtitle: (id: string | null) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 bg-black/55 backdrop-blur-sm" onClick={onClose} role="presentation">
      <aside
        aria-label="Playback settings"
        className="ml-auto flex h-full w-full max-w-sm flex-col border-l border-white/10 bg-[#09090b]/97 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-5">
          <div>
            <p className="text-[0.65rem] font-medium uppercase tracking-[0.14em] text-white/35">Player</p>
            <h2 className="mt-1 text-base font-medium text-white">Settings</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close settings" className="cursor-pointer rounded-full p-2 text-white/45 transition hover:bg-white/8 hover:text-white">
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6" data-lenis-prevent>
          <section>
            <h3 className="text-sm font-medium text-white">Subtitles</h3>
            <p className="mt-1 text-xs leading-relaxed text-white/38">Choose a language or leave subtitles off.</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <OptionButton active={activeSubtitleId === null} label="Off" onClick={() => onPickSubtitle(null)} />
              {subtitles.map((track) => (
                <OptionButton key={track.id} active={track.id === activeSubtitleId} label={track.label} onClick={() => onPickSubtitle(track.id)} />
              ))}
            </div>
          </section>

          <section className="mt-9 border-t border-white/10 pt-7">
            <h3 className="text-sm font-medium text-white">Video source</h3>
            <p className="mt-1 text-xs leading-relaxed text-white/38">Cubo chooses the most compatible option automatically. Change it only if playback has a problem.</p>
            <ul className="mt-4 m-0 list-none space-y-2 p-0">
              {sources.map((stream, index) => {
                const active = streamKey(stream) === activeKey;
                return (
                  <li key={`${streamKey(stream)}-${index}`}>
                    <button
                      type="button"
                      onClick={() => onPickSource(index)}
                      className={`w-full cursor-pointer rounded-xl border px-3.5 py-3 text-left transition ${active ? 'border-white/22 bg-white/8' : 'border-white/8 hover:border-white/16 hover:bg-white/5'}`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="text-xs font-medium text-white">{index === 0 ? 'Best available' : `Alternative ${index}`}</span>
                        {active ? <Check weight="bold" className="ml-auto size-3.5 text-accent" /> : null}
                      </span>
                      <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.68rem] text-white/42">
                        <span>{friendlyQuality(stream.quality)}</span>
                        {stream.sizeBytes ? <><span className="text-white/18">·</span><span>{formatSize(stream.sizeBytes)}</span></> : null}
                        <span className="text-white/18">·</span>
                        <span>{connectionLabel(stream.seeders)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {hiddenCount > 0 ? (
              <p className="mt-4 text-[0.68rem] leading-relaxed text-white/28">{hiddenCount} options were hidden because this browser cannot play them reliably.</p>
            ) : null}
          </section>
        </div>
      </aside>
    </div>
  );
}

function OptionButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex cursor-pointer items-center justify-between rounded-xl border px-3 py-2.5 text-left text-xs transition ${active ? 'border-white/22 bg-white/8 text-white' : 'border-white/8 text-white/55 hover:border-white/16 hover:text-white'}`}>
      <span className="truncate">{label}</span>
      {active ? <Check weight="bold" className="size-3 text-accent" /> : null}
    </button>
  );
}

function friendlyQuality(quality: string | null): string {
  switch (quality?.toLowerCase()) {
    case '2160p': return '4K';
    case '1080p': return 'Full HD';
    case '720p': return 'HD';
    case '480p': return 'Standard';
    default: return 'Auto quality';
  }
}

function connectionLabel(seeders: number | null): string {
  if (seeders == null) return 'Connection unknown';
  if (seeders >= 100) return 'Strong connection';
  if (seeders >= 20) return 'Good connection';
  return 'Limited connection';
}
