import { IoCheckmark, IoClose } from 'react-icons/io5';
import type { PlayerSubtitle } from './video-player';

/** Cubo picks the video source automatically and falls back on failure, so the
 *  panel only exposes subtitles. The old manual source list lives in git
 *  history if it ever needs to return. */
export function PlayerSettings({
  subtitles,
  activeSubtitleId,
  onPickSubtitle,
  onClose,
}: {
  subtitles: PlayerSubtitle[];
  activeSubtitleId: string | null;
  onPickSubtitle: (id: string | null) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 bg-black/55 backdrop-blur-sm" onClick={onClose} role="presentation">
      <aside
        aria-label="Playback settings"
        className="ml-auto flex h-full w-full max-w-sm flex-col border-l border-white/10 bg-panel/97 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-5">
          <div>
            <p className="text-sm font-semibold text-white/50">Player</p>
            <h2 className="mt-1 text-xl font-semibold text-white">Settings</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close settings" className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-white/45 transition-colors hover:bg-control hover:text-white">
            <IoClose size={20} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          <section>
            <h3 className="font-semibold text-white">Subtitles</h3>
            <p className="mt-1 text-sm leading-6 text-white/38">Choose a language or leave subtitles off.</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <OptionButton active={activeSubtitleId === null} label="Off" onClick={() => onPickSubtitle(null)} />
              {subtitles.map((track) => (
                <OptionButton key={track.id} active={track.id === activeSubtitleId} label={track.label} onClick={() => onPickSubtitle(track.id)} />
              ))}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function OptionButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex cursor-pointer items-center justify-between rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${active ? 'border-white/22 bg-white/8 text-white' : 'border-white/8 text-white/55 hover:border-white/16 hover:text-white'}`}>
      <span className="truncate">{label}</span>
      {active ? <IoCheckmark size={14} className="text-accent" /> : null}
    </button>
  );
}
