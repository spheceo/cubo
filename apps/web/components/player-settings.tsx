import { useState } from 'react';
import { IoCheckmark, IoChevronBack, IoChevronForward } from 'react-icons/io5';
import type { PlayerSubtitle } from './video-player';

type Panel = 'root' | 'subtitles';

/** Compact menu anchored above the gear. Root lists sections; subtitles
 *  open as a second pane so the first click is never a language flood. */
export function PlayerSettings({
  subtitles,
  activeSubtitleId,
  onPickSubtitle,
}: {
  subtitles: PlayerSubtitle[];
  activeSubtitleId: string | null;
  onPickSubtitle: (id: string | null) => void;
}) {
  const [panel, setPanel] = useState<Panel>('root');
  const active = subtitles.find((track) => track.id === activeSubtitleId);

  return (
    <div
      role="dialog"
      aria-label="Playback settings"
      className="absolute bottom-12 right-0 z-20 w-56 overflow-hidden rounded-xl border border-white/10 bg-black/92 py-1 shadow-2xl backdrop-blur-md"
    >
      {panel === 'root' ? (
        <button
          type="button"
          onClick={() => setPanel('subtitles')}
          className="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-left text-sm text-white transition-colors hover:bg-white/8"
        >
          <span>Subtitles</span>
          <span className="flex min-w-0 items-center gap-1 text-white/45">
            <span className="truncate">{active?.label ?? 'Off'}</span>
            <IoChevronForward size={14} className="shrink-0" />
          </span>
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setPanel('root')}
            className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-left text-sm text-white/70 transition-colors hover:bg-white/8 hover:text-white"
          >
            <IoChevronBack size={14} />
            Subtitles
          </button>
          <div className="max-h-56 overflow-y-auto border-t border-white/8">
            <OptionRow
              label="Off"
              active={activeSubtitleId === null}
              onClick={() => onPickSubtitle(null)}
            />
            {subtitles.map((track) => (
              <OptionRow
                key={track.id}
                label={track.label}
                active={track.id === activeSubtitleId}
                onClick={() => onPickSubtitle(track.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function OptionRow({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2 text-left text-sm transition-colors hover:bg-white/8 ${
        active ? 'text-white' : 'text-white/55 hover:text-white'
      }`}
    >
      <span className="truncate">{label}</span>
      {active ? <IoCheckmark size={14} className="shrink-0 text-white" /> : null}
    </button>
  );
}
