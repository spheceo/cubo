import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CaretLeft,
  GearSix,
  Pause,
  PictureInPicture,
  Play,
  SpeakerHigh,
  SpeakerLow,
  SpeakerSlash,
  CornersIn,
  CornersOut,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@/components/link';
import { LogoLoader } from './logo-loader';
import { formatTime } from '@/lib/format';

const HIDE_DELAY_MS = 2600;
const SKIP_SECONDS = 10;
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

type BufferedRange = {
  start: number;
  end: number;
};

export type PlayerSubtitle = {
  id: string;
  src: string;
  language: string;
  label: string;
};

export function VideoPlayer({
  src,
  title,
  subtitle,
  logoPath,
  backHref,
  onOpenSettings,
  subtitles,
  activeSubtitleId,
  initialTime = 0,
  onPlaybackProgress,
  onError,
}: {
  src: string;
  title: string;
  subtitle: string | null;
  logoPath: string | null;
  backHref: string;
  onOpenSettings: () => void;
  subtitles: PlayerSubtitle[];
  activeSubtitleId: string | null;
  initialTime?: number;
  onPlaybackProgress: (
    positionSeconds: number,
    durationSeconds: number,
    watchedDeltaSeconds: number,
    sessionStarted: boolean,
  ) => void;
  onError: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  const scrubFrame = useRef<number | null>(null);
  const pendingScrubRatio = useRef(0);
  const scrubbing = useRef(false);
  const initialSeekApplied = useRef(false);
  const lastProgressReport = useRef(0);
  const lastProgressWallTime = useRef(0);
  const sessionReported = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedRanges, setBufferedRanges] = useState<BufferedRange[]>([]);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [pipSupported, setPipSupported] = useState(false);

  useEffect(() => setPipSupported(document.pictureInPictureEnabled), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    for (let index = 0; index < video.textTracks.length; index += 1) {
      const track = video.textTracks[index];
      track.mode = subtitles[index]?.id === activeSubtitleId ? 'showing' : 'disabled';
    }
  }, [activeSubtitleId, subtitles]);

  const keepControls = speedOpen || !playing || blocked;

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), HIDE_DELAY_MS);
  }, []);

  useEffect(() => {
    if (keepControls) {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      setControlsVisible(true);
    }
  }, [keepControls]);

  useEffect(
    () => () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (scrubFrame.current) window.cancelAnimationFrame(scrubFrame.current);
    },
    [],
  );

  const reportPlayback = useCallback(
    (sessionStarted = false) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
      const now = performance.now();
      const watchedDelta = lastProgressWallTime.current
        ? Math.min(30, Math.max(0, (now - lastProgressWallTime.current) / 1000))
        : 0;
      lastProgressWallTime.current = video.paused ? 0 : now;
      lastProgressReport.current = now;
      onPlaybackProgress(video.currentTime, video.duration, watchedDelta, sessionStarted);
    },
    [onPlaybackProgress],
  );

  useEffect(() => {
    const flush = () => reportPlayback(false);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [reportPlayback]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
    } else {
      video.pause();
    }
  }, []);

  const seekBy = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
    revealControls();
  }, [revealControls]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current?.requestFullscreen().catch(() => undefined);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;

      const video = videoRef.current;
      if (!video) return;

      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          seekBy(-SKIP_SECONDS);
          break;
        case 'ArrowRight':
          seekBy(SKIP_SECONDS);
          break;
        case 'ArrowUp':
          event.preventDefault();
          video.volume = Math.min(1, video.volume + 0.1);
          revealControls();
          break;
        case 'ArrowDown':
          event.preventDefault();
          video.volume = Math.max(0, video.volume - 0.1);
          revealControls();
          break;
        case 'm':
          toggleMute();
          break;
        case 'f':
          toggleFullscreen();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [togglePlay, seekBy, toggleMute, toggleFullscreen, revealControls]);

  function syncBuffered(video: HTMLVideoElement) {
    const ranges = video.buffered;
    const nextRanges: BufferedRange[] = [];
    for (let index = 0; index < ranges.length; index += 1) {
      nextRanges.push({ start: ranges.start(index), end: ranges.end(index) });
    }
    setBufferedRanges(nextRanges);
  }

  function ratioFromPointer(clientX: number): number {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function commitSeek(ratio: number) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = ratio * video.duration;
  }

  function scheduleScrub(ratio: number) {
    pendingScrubRatio.current = ratio;
    if (scrubFrame.current !== null) return;
    scrubFrame.current = window.requestAnimationFrame(() => {
      const next = pendingScrubRatio.current;
      setHoverRatio(next);
      if (scrubbing.current) setScrubTime(next * duration);
      scrubFrame.current = null;
    });
  }

  const shownTime = scrubTime ?? currentTime;
  const playedRatio = duration ? Math.min(1, shownTime / duration) : 0;
  const volumeLevel = muted || volume === 0 ? 'muted' : volume < 0.5 ? 'low' : 'high';

  return (
    <div
      ref={containerRef}
      onPointerMove={revealControls}
      onPointerLeave={() => !keepControls && setControlsVisible(false)}
      className={`group/player relative h-full w-full overflow-hidden bg-black ${
        controlsVisible ? '' : 'cursor-none'
      }`}
    >
      <video
        ref={videoRef}
        src={src}
        autoPlay
        playsInline
        crossOrigin="anonymous"
        className="h-full w-full bg-black"
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onPlay={() => {
          setPlaying(true);
          setBlocked(false);
          lastProgressWallTime.current = performance.now();
          if (!sessionReported.current) {
            sessionReported.current = true;
            reportPlayback(true);
          }
          revealControls();
        }}
        onPause={() => {
          setPlaying(false);
          reportPlayback(false);
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          setCurrentTime(video.currentTime);
          syncBuffered(video);
          if (performance.now() - lastProgressReport.current >= 10_000) {
            reportPlayback(false);
          }
        }}
        onProgress={(event) => syncBuffered(event.currentTarget)}
        onDurationChange={(event) => {
          const video = event.currentTarget;
          setDuration(video.duration || 0);
          if (!initialSeekApplied.current && initialTime > 5 && video.duration > initialTime) {
            initialSeekApplied.current = true;
            video.currentTime = initialTime;
          }
        }}
        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
        onRateChange={(event) => setSpeed(event.currentTarget.playbackRate)}
        onError={onError}
      >
        {subtitles.map((track) => (
          <track
            key={track.id}
            kind="subtitles"
            src={track.src}
            srcLang={track.language}
            label={track.label}
            default={track.id === activeSubtitleId}
          />
        ))}
      </video>

      {waiting && !blocked ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40">
          <LogoLoader logoPath={logoPath} title={title} progress={null} size="sm" />
        </div>
      ) : null}

      {blocked ? (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/40"
        >
          <span className="flex size-20 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white backdrop-blur-sm transition hover:bg-black/70">
            <Play weight="fill" className="ml-1 size-8" />
          </span>
        </button>
      ) : null}

      {/* Top chrome */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 flex items-start bg-linear-to-b from-black/80 via-black/30 to-transparent px-4 pb-12 pt-4 transition-opacity duration-300 sm:px-6 ${
          controlsVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <Link
          href={backHref}
          className="pointer-events-auto flex min-w-0 items-center gap-3 text-white/80 transition-colors hover:text-white"
        >
          <CaretLeft className="size-5 shrink-0" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{title}</span>
            {subtitle ? (
              <span className="block truncate text-[0.72rem] text-white/45">{subtitle}</span>
            ) : null}
          </span>
        </Link>

      </div>

      {/* Bottom chrome */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-linear-to-t from-black/85 via-black/45 to-transparent px-4 pb-4 pt-16 transition-opacity duration-300 sm:px-6 sm:pb-5 ${
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        {/* Scrub bar */}
        <div
          className="group/bar relative -mx-1 touch-none cursor-pointer px-1 py-2.5"
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const ratio = ratioFromPointer(event.clientX);
            scrubbing.current = true;
            setHoverRatio(ratio);
            setScrubTime(ratio * duration);
          }}
          onPointerMove={(event) => {
            const ratio = ratioFromPointer(event.clientX);
            scheduleScrub(ratio);
          }}
          onPointerUp={(event) => {
            const ratio = ratioFromPointer(event.clientX);
            commitSeek(ratio);
            scrubbing.current = false;
            setScrubTime(null);
          }}
          onPointerCancel={() => {
            scrubbing.current = false;
            setScrubTime(null);
          }}
          onPointerLeave={() => {
            if (!scrubbing.current) setHoverRatio(null);
          }}
        >
          <div ref={barRef} className="relative h-[3px] w-full rounded-full bg-white/15">
            {duration > 0
              ? bufferedRanges.map((range, index) => {
                  const start = Math.max(0, Math.min(1, range.start / duration));
                  const end = Math.max(start, Math.min(1, range.end / duration));
                  return (
                    <span
                      key={`${range.start}-${range.end}-${index}`}
                      aria-hidden="true"
                      className="absolute inset-y-0 rounded-full bg-white/55 shadow-[0_0_5px_rgba(255,255,255,0.18)]"
                      style={{
                        left: `${start * 100}%`,
                        width: `${(end - start) * 100}%`,
                      }}
                    />
                  );
                })
              : null}
            <div
              className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-accent will-change-transform"
              style={{ transform: `scaleX(${playedRatio})` }}
            />
            <span
              className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 transition-opacity will-change-[left] group-hover/bar:opacity-100"
              style={{ left: `${playedRatio * 100}%` }}
            />
          </div>

          {hoverRatio !== null && duration ? (
            <span
              className="pointer-events-none absolute bottom-7 -translate-x-1/2 rounded-md bg-black/80 px-2 py-1 text-[0.7rem] tabular-nums text-white will-change-[left]"
              style={{ left: `${hoverRatio * 100}%` }}
            >
              {formatTime(hoverRatio * duration)}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2.5">
          <ControlButton label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
            {playing ? <Pause weight="fill" className="size-5" /> : <Play weight="fill" className="size-5" />}
          </ControlButton>

          <ControlButton label="Back 10 seconds" onClick={() => seekBy(-SKIP_SECONDS)}>
            <ArrowCounterClockwise className="size-5" />
          </ControlButton>
          <ControlButton label="Forward 10 seconds" onClick={() => seekBy(SKIP_SECONDS)}>
            <ArrowClockwise className="size-5" />
          </ControlButton>

          <div className="group/vol flex items-center gap-2">
            <ControlButton label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
              {volumeLevel === 'muted' ? (
                <SpeakerSlash className="size-5" />
              ) : volumeLevel === 'low' ? (
                <SpeakerLow className="size-5" />
              ) : (
                <SpeakerHigh className="size-5" />
              )}
            </ControlButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              aria-label="Volume"
              onChange={(event) => {
                const video = videoRef.current;
                if (!video) return;
                video.volume = Number(event.target.value);
                video.muted = Number(event.target.value) === 0;
              }}
              className="h-1 w-0 cursor-pointer appearance-none rounded-full bg-white/25 opacity-0 transition-all duration-200 group-hover/vol:w-20 group-hover/vol:opacity-100 focus-visible:w-20 focus-visible:opacity-100 [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
            />
          </div>

          <p className="ml-1 m-0 flex items-center text-[0.75rem] tabular-nums text-white/70">
            {formatTime(shownTime)}
            <span className="mx-1.5 text-white/30">/</span>
            {formatTime(duration)}
          </p>

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2.5">
            <div className="relative">
              <button
                type="button"
                onClick={() => setSpeedOpen((open) => !open)}
                aria-label="Playback speed"
                className="cursor-pointer rounded-full px-2.5 py-1.5 text-[0.75rem] font-medium tabular-nums text-white/80 transition-colors hover:bg-white/10 hover:text-white"
              >
                {speed}×
              </button>
              {speedOpen ? (
                <div className="absolute bottom-10 right-0 w-24 overflow-hidden rounded-xl border border-white/10 bg-black/90 py-1 backdrop-blur-sm">
                  {SPEEDS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => {
                        if (videoRef.current) videoRef.current.playbackRate = option;
                        setSpeedOpen(false);
                      }}
                      className={`block w-full cursor-pointer px-3 py-1.5 text-left text-[0.75rem] tabular-nums transition-colors hover:bg-white/10 ${
                        option === speed ? 'text-accent' : 'text-white/75'
                      }`}
                    >
                      {option}×
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <ControlButton label="Playback settings" onClick={onOpenSettings}>
              <GearSix className="size-5" />
            </ControlButton>

            {pipSupported ? (
              <ControlButton
                label="Picture in picture"
                onClick={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  if (document.pictureInPictureElement) void document.exitPictureInPicture();
                  else void video.requestPictureInPicture().catch(() => undefined);
                }}
              >
                <PictureInPicture className="size-5" />
              </ControlButton>
            ) : null}

            <ControlButton
              label={fullscreen ? 'Exit full screen' : 'Full screen'}
              onClick={toggleFullscreen}
            >
              {fullscreen ? <CornersIn className="size-5" /> : <CornersOut className="size-5" />}
            </ControlButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex cursor-pointer items-center justify-center rounded-full p-2 text-white/85 transition-colors hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}
