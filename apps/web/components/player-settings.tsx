import { useState } from 'react';
import { IoCheckmark, IoChevronBack, IoChevronForward } from 'react-icons/io5';
import {
  CAPTION_COLORS,
  type CaptionColor,
  type CaptionSize,
} from '@/lib/caption-prefs';
import {
  FRAMING_LABELS,
  type FramingMode,
} from '@/lib/framing-prefs';
import type { PlayerSubtitle } from './video-player';

type Panel = 'root' | 'subtitles' | 'language' | 'size' | 'color' | 'framing';

const FRAMING_MODES: FramingMode[] = ['fit', 'fill-width', 'fill-height', 'auto'];

const SIZES: { value: CaptionSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

/** Compact menu anchored above the gear. Root lists sections; everything
 *  caption-related lives INSIDE the Subtitles section — language, size, and
 *  color each get their own pane, keeping the root clean for new settings. */
export function PlayerSettings({
  subtitles,
  activeSubtitleId,
  onPickSubtitle,
  captionSize,
  onPickCaptionSize,
  captionColor,
  onPickCaptionColor,
  framing = 'fit',
  onPickFraming,
}: {
  subtitles: PlayerSubtitle[];
  activeSubtitleId: string | null;
  onPickSubtitle: (id: string | null) => void;
  captionSize: CaptionSize;
  onPickCaptionSize: (size: CaptionSize) => void;
  captionColor: CaptionColor;
  onPickCaptionColor: (color: CaptionColor) => void;
  framing?: FramingMode;
  onPickFraming?: (mode: FramingMode) => void;
}) {
  const [panel, setPanel] = useState<Panel>('root');
  const active = subtitles.find((track) => track.id === activeSubtitleId);
  const sizeLabel = SIZES.find((size) => size.value === captionSize)?.label ?? 'Medium';
  const colorEntry =
    CAPTION_COLORS.find((entry) => entry.value === captionColor) ?? CAPTION_COLORS[0];
  const framingLabel = FRAMING_LABELS[framing];

  if (panel === 'subtitles') {
    return (
      <div
        role="dialog"
        aria-label="Playback settings"
        className="absolute bottom-12 right-0 z-20 w-56 overflow-hidden rounded-xl border border-white/10 bg-black/92 py-1 shadow-2xl backdrop-blur-md"
      >
        <PaneHeader label="Subtitles" onBack={() => setPanel('root')} />
        <div className="border-t border-white/8">
          <SubRow label="Language" value={active?.label ?? 'Off'} onClick={() => setPanel('language')} />
          <SubRow label="Size" value={sizeLabel} onClick={() => setPanel('size')} />
          <SubRow
            label="Color"
            value={colorEntry.label}
            swatch={colorEntry.hex}
            onClick={() => setPanel('color')}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Playback settings"
      className="absolute bottom-12 right-0 z-20 w-56 overflow-hidden rounded-xl border border-white/10 bg-black/92 shadow-2xl backdrop-blur-md"
    >
      {panel === 'framing' ? (
        <>
          <PaneHeader label="Framing" onBack={() => setPanel('root')} />
          <div className="py-1">
            {FRAMING_MODES.map((mode) => (
              <OptionRow
                key={mode}
                label={FRAMING_LABELS[mode]}
                active={mode === framing}
                onClick={() => onPickFraming?.(mode)}
              />
            ))}
          </div>
        </>
      ) : panel === 'language' ? (
        <>
          <PaneHeader label="Language" onBack={() => setPanel('subtitles')} />
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
      ) : panel === 'size' ? (
        <>
          <PaneHeader label="Size" onBack={() => setPanel('subtitles')} />
          <div className="py-1">
            {SIZES.map((size) => (
              <OptionRow
                key={size.value}
                label={size.label}
                active={size.value === captionSize}
                onClick={() => onPickCaptionSize(size.value)}
              />
            ))}
          </div>
        </>
      ) : panel === 'color' ? (
        <>
          <PaneHeader label="Color" onBack={() => setPanel('subtitles')} />
          <div className="py-1">
            {CAPTION_COLORS.map((entry) => (
              <OptionRow
                key={entry.value}
                label={entry.label}
                active={entry.value === captionColor}
                swatch={entry.hex}
                onClick={() => onPickCaptionColor(entry.value)}
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setPanel('framing')}
            className="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-left text-sm text-white transition-colors hover:bg-white/8"
          >
            <span>Framing</span>
            <span className="flex min-w-0 items-center gap-1 text-white/45">
              <span className="truncate">{framingLabel}</span>
              <IoChevronForward size={14} className="shrink-0" />
            </span>
          </button>
          <div className="border-t border-white/8" />
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
        </>
      )}
    </div>
  );
}

function SubRow({
  label,
  value,
  swatch,
  onClick,
}: {
  label: string;
  value: string;
  /** Optional color dot shown before the current value. */
  swatch?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-left text-sm text-white transition-colors hover:bg-white/8"
    >
      <span>{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-white/45">
        {swatch ? (
          <span
            className="inline-block size-3 shrink-0 rounded-full border border-white/25"
            style={{ backgroundColor: swatch }}
          />
        ) : null}
        <span className="truncate">{value}</span>
        <IoChevronForward size={14} className="shrink-0" />
      </span>
    </button>
  );
}

function PaneHeader({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-left text-sm text-white/70 transition-colors hover:bg-white/8 hover:text-white"
    >
      <IoChevronBack size={14} />
      {label}
    </button>
  );
}

function OptionRow({
  label,
  active = false,
  swatch,
  onClick,
}: {
  label: string;
  active?: boolean;
  /** Optional color dot shown before the label. */
  swatch?: string;
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
      <span className="flex min-w-0 items-center gap-2">
        {swatch ? (
          <span
            className="inline-block size-3 shrink-0 rounded-full border border-white/25"
            style={{ backgroundColor: swatch }}
          />
        ) : null}
        <span className="truncate">{label}</span>
      </span>
      {active ? <IoCheckmark size={14} className="shrink-0 text-white" /> : null}
    </button>
  );
}
