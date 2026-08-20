/**
 * Cubo's video player. Part of the verified-working playback pipeline
 * (see AGENTS.md) — two properties here are load-bearing:
 *
 * 1. Remuxed (HLS) sources always play through hls.js, never the native HLS
 *    stack, because native players treat Core's growing playlist as live.
 * 2. All displayed, reported, and sought positions are ABSOLUTE movie time:
 *    a remux playlist starts `timeOffset` seconds into the source, and seeks
 *    outside the converted window hand off to `onSeekOutside` so the owner
 *    can restart the converter at the target.
 */
import {
  IoContract,
  IoExpand,
  IoPause,
  IoPlay,
  IoPlayBack,
  IoPlayForward,
  IoSettingsSharp,
  IoTabletLandscape,
  IoVolumeHigh,
  IoVolumeLow,
  IoVolumeMute,
} from 'react-icons/io5';
import { IoIosArrowBack } from 'react-icons/io';
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
  hls = false,
  durationHint = null,
  timeOffset = 0,
  title,
  subtitle,
  logoPath,
  backHref,
  onOpenSettings,
  subtitles,
  activeSubtitleId,
  initialTime = 0,
  onPlaybackProgress,
  onSeekOutside,
  onError,
}: {
  src: string;
  /** True when `src` is an HLS playlist from Core's remux pipeline. */
  hls?: boolean;
  /** Full source duration reported by Core while a growing HLS playlist is incomplete. */
  durationHint?: number | null;
  /** Seconds into the source where this HLS playlist begins (seek restart).
   *  All reported and displayed times are offset by this amount. */
  timeOffset?: number;
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
  /** Called with an absolute target when a seek lands outside the converted
   *  window, so the owner can restart the converter at that position. */
  onSeekOutside?: (absoluteSeconds: number) => void;
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

  // Callbacks and the offset live in refs so the media-source effect and the
  // stable seek helpers never go stale or rerun on unrelated renders.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onSeekOutsideRef = useRef(onSeekOutside);
  onSeekOutsideRef.current = onSeekOutside;
  const timeOffsetRef = useRef(timeOffset);
  timeOffsetRef.current = timeOffset;

  const resolveDuration = useCallback(
    (video: HTMLVideoElement) => {
      if (hls && durationHint && Number.isFinite(durationHint)) return durationHint;
      if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
      return durationHint && Number.isFinite(durationHint) ? durationHint : 0;
    },
    [durationHint, hls],
  );

  useEffect(() => {
    setDuration(hls && durationHint && Number.isFinite(durationHint) ? durationHint : 0);
    setCurrentTime(0);
    setBufferedRanges([]);
    setWaiting(true);
  }, [src, hls, durationHint]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!hls) {
      video.src = src;
      return () => {
        video.removeAttribute('src');
      };
    }

    // Remuxed sources ALWAYS go through hls.js — never the native HLS stack.
    // Core's playlist grows while ffmpeg works, and native players (Safari,
    // WKWebView in the desktop app) treat a growing playlist as a live
    // broadcast: play() snaps to the live edge and seeking is confined to a
    // sliding window. hls.js with an explicit startPosition keeps normal
    // video-on-demand behaviour.
    let cancelled = false;
    let instance: import('hls.js').default | null = null;
    void import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) {
        onErrorRef.current();
        return;
      }
      instance = new Hls({ startPosition: 0 });
      instance.loadSource(src);
      instance.attachMedia(video);
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) onErrorRef.current();
      });
    });

    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, [src, hls]);

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
      if (!video) return;
      const fullDuration = resolveDuration(video);
      if (fullDuration <= 0) return;
      const now = performance.now();
      const watchedDelta = lastProgressWallTime.current
        ? Math.min(30, Math.max(0, (now - lastProgressWallTime.current) / 1000))
        : 0;
      lastProgressWallTime.current = video.paused ? 0 : now;
      lastProgressReport.current = now;
      onPlaybackProgress(
        timeOffsetRef.current + video.currentTime,
        fullDuration,
        watchedDelta,
        sessionStarted,
      );
    },
    [onPlaybackProgress, resolveDuration],
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

  /** Seeks to an absolute source position. Inside the converted window it is
   *  an ordinary seek; outside it (with slack near the frontier, where waiting
   *  a moment is faster than restarting ffmpeg) the owner restarts the
   *  converter at the target — no more clamping to a spot before the target
   *  and hanging there. */
  const seekToAbsolute = useCallback(
    (absoluteSeconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      const offset = timeOffsetRef.current;
      const local = absoluteSeconds - offset;
      const seekable = video.seekable;

      if (hls && onSeekOutsideRef.current && seekable.length > 0) {
        const seekableStart = seekable.start(0);
        const seekableEnd = seekable.end(seekable.length - 1);
        if (local < seekableStart - 1 || local > seekableEnd + 10) {
          onSeekOutsideRef.current(Math.max(0, absoluteSeconds));
          return;
        }
      }
      video.currentTime = clampToSeekable(video, local);
    },
    [hls],
  );

  const seekBy = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const fullDuration = resolveDuration(video);
    const absolute = timeOffsetRef.current + video.currentTime + seconds;
    seekToAbsolute(Math.max(0, Math.min(fullDuration || Infinity, absolute)));
    revealControls();
  }, [resolveDuration, revealControls, seekToAbsolute]);

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
      if (
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('button, a, input, select, textarea, [contenteditable="true"], [role="button"]')
      ) {
        return;
      }

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
    if (!video) return;
    const fullDuration = resolveDuration(video);
    if (fullDuration <= 0) return;
    seekToAbsolute(ratio * fullDuration);
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

  const shownTime = scrubTime ?? timeOffset + currentTime;
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
          const fullDuration = resolveDuration(video);
          setDuration(fullDuration);
          // Direct sources know their full duration up front, so the resume
          // seek is safe here. HLS resume is handled once by the playlist
          // loader — reacting to growing durations here caused playback to
          // suddenly jump forward mid-watch.
          if (!hls && !initialSeekApplied.current && initialTime > 5 && fullDuration > initialTime) {
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
          <span className="flex size-20 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-md transition-colors hover:bg-black/75">
            <IoPlay size={34} className="ml-1" />
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
          className="pointer-events-auto flex min-w-0 items-center gap-4 text-white transition-colors hover:text-white/80"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/55 backdrop-blur-md">
            <IoIosArrowBack size={22} />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold">{title}</span>
            {subtitle ? (
              <span className="block truncate text-sm text-white/45">{subtitle}</span>
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
                  const start = Math.max(0, Math.min(1, (range.start + timeOffset) / duration));
                  const end = Math.max(start, Math.min(1, (range.end + timeOffset) / duration));
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
            {playing ? <IoPause size={21} /> : <IoPlay size={21} />}
          </ControlButton>

          <ControlButton label="Back 10 seconds" onClick={() => seekBy(-SKIP_SECONDS)}>
            <IoPlayBack size={21} />
          </ControlButton>
          <ControlButton label="Forward 10 seconds" onClick={() => seekBy(SKIP_SECONDS)}>
            <IoPlayForward size={21} />
          </ControlButton>

          <div className="group/vol flex items-center gap-2">
            <ControlButton label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
              {volumeLevel === 'muted' ? (
                <IoVolumeMute size={21} />
              ) : volumeLevel === 'low' ? (
                <IoVolumeLow size={21} />
              ) : (
                <IoVolumeHigh size={21} />
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
              <IoSettingsSharp size={20} />
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
                <IoTabletLandscape size={21} />
              </ControlButton>
            ) : null}

            <ControlButton
              label={fullscreen ? 'Exit full screen' : 'Full screen'}
              onClick={toggleFullscreen}
            >
              {fullscreen ? <IoContract size={21} /> : <IoExpand size={21} />}
            </ControlButton>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Keeps a seek target inside what the source can actually serve. Direct
 *  streams are fully seekable so this is a no-op; on a growing HLS playlist it
 *  lands the seek at the conversion frontier instead of being ignored. */
function clampToSeekable(video: HTMLVideoElement, target: number): number {
  const seekable = video.seekable;
  if (seekable.length === 0) return target;
  const start = seekable.start(0);
  const end = seekable.end(seekable.length - 1);
  return Math.max(start, Math.min(target, Math.max(start, end - 0.5)));
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
