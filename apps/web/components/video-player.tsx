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
  IoVolumeHigh,
  IoVolumeLow,
  IoVolumeMute,
} from 'react-icons/io5';
import {
  MdClosedCaption,
  MdClosedCaptionOff,
  MdPictureInPictureAlt,
} from 'react-icons/md';
import { IoIosArrowBack } from 'react-icons/io';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isDesktopRuntime } from '@/lib/local-engine';
import type { CaptionColor, CaptionSize } from '@/lib/caption-prefs';
import { CAPTION_COLORS } from '@/lib/caption-prefs';
import {
  loadFramingPref,
  saveFramingPref,
  type FramingMode,
} from '@/lib/framing-prefs';
import { findActiveCue, loadSubtitleCues, type SubtitleCue } from '@/lib/subtitles';
import { LogoLoader } from './logo-loader';
import { PlayerSettings } from './player-settings';
import { formatTime } from '@/lib/format';

const HIDE_DELAY_MS = 2600;
const SKIP_SECONDS = 10;

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
  logoPath = null,
  backHref,
  onBack,
  onPickSubtitle,
  onEnableCaptions,
  captionSize = 'medium',
  onPickCaptionSize,
  captionColor = 'white',
  onPickCaptionColor,
  subtitles,
  activeSubtitleId,
  initialTime = 0,
  startTimeLocal = null,
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
  /** TMDB logotype for the playing title, shown by the buffering loader. */
  logoPath?: string | null;
  backHref: string;
  /** History-back navigation; falls back to `backHref` when absent. */
  onBack?: () => void;
  onPickSubtitle: (id: string | null) => void;
  /** Enables captions using the viewer's saved language preference.
   *  Falls back to the first track when not provided. */
  onEnableCaptions?: () => void;
  captionSize?: CaptionSize;
  onPickCaptionSize: (size: CaptionSize) => void;
  subtitles: PlayerSubtitle[];
  activeSubtitleId: string | null;
  initialTime?: number;
  /** Playlist-local position to jump to once the source can seek — used after
   *  a seek restart to make up the gap between the keyframe ffmpeg landed on
   *  and the exact spot the viewer asked for. Applied once per source. */
  startTimeLocal?: number | null;
  captionColor?: CaptionColor;
  onPickCaptionColor: (color: CaptionColor) => void;
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
  const settingsRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  const scrubFrame = useRef<number | null>(null);
  const pendingScrubRatio = useRef(0);
  const scrubbing = useRef(false);
  const initialSeekApplied = useRef(false);
  const lastProgressReport = useRef(0);
  const lastProgressWallTime = useRef(0);
  const sessionReported = useRef(false);
  /** One-shot local seek (seek-restart catch-up), applied per source. */
  const localSeekApplied = useRef<string | null>(null);

  // Framing preference is player-global (like a TV picture-size setting):
  // it follows the viewer across titles, so the player owns it directly.
  const [framing, setFraming] = useState<FramingMode>(() => loadFramingPref());
  const pickFraming = useCallback((mode: FramingMode) => {
    setFraming(mode);
    saveFramingPref(mode);
  }, []);

  const goBack = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    window.location.assign(backHref);
  }, [onBack, backHref]);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedRanges, setBufferedRanges] = useState<BufferedRange[]>([]);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [pipSupported, setPipSupported] = useState(false);
  const [activeCueText, setActiveCueText] = useState<string | null>(null);

  useEffect(() => setPipSupported(document.pictureInPictureEnabled), []);

  // Callbacks and the offset live in refs so the media-source effect and the
  // stable seek helpers never go stale or rerun on unrelated renders.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onSeekOutsideRef = useRef(onSeekOutside);
  onSeekOutsideRef.current = onSeekOutside;
  const timeOffsetRef = useRef(timeOffset);
  timeOffsetRef.current = timeOffset;

  // Subtitles are rendered by Cubo, not the browser's native track layer:
  // cues are timed against the original file, so they are looked up against
  // ABSOLUTE movie time (timeOffset + currentTime) — the same invariant as
  // every other displayed position. This keeps them aligned on remuxed
  // sources and re-aligns automatically after seek restarts.
  const subtitleCuesRef = useRef<SubtitleCue[]>([]);
  /** Set by the cue-display effect; lets the cue-loading effect repaint the
   *  visible caption once even while the frame loop sleeps (video paused). */
  const refreshCueRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    subtitleCuesRef.current = [];
    setActiveCueText(null);
    if (!activeSubtitleId) return;
    const track = subtitles.find((entry) => entry.id === activeSubtitleId);
    if (!track) return;
    let cancelled = false;
    void loadSubtitleCues(track.src).then((cues) => {
      if (cancelled) return;
      subtitleCuesRef.current = cues;
      // Repaint immediately: the frame loop sleeps while the video is
      // paused, so captions toggled on during a pause would otherwise stay
      // blank until play/seek.
      refreshCueRef.current();
    });
    return () => {
      cancelled = true;
    };
  }, [activeSubtitleId, subtitles]);

  useEffect(() => {
    if (!activeSubtitleId) return;
    let frame: number | null = null;
    const update = () => {
      const video = videoRef.current;
      const cues = subtitleCuesRef.current;
      if (!video || cues.length === 0) return;
      const cue = findActiveCue(cues, timeOffsetRef.current + video.currentTime);
      const text = cue?.text ?? null;
      setActiveCueText((previous) => (previous === text ? previous : text));
    };
    const tick = () => {
      update();
      // The frame loop only runs while the picture moves; waking 60+ times a
      // second through a two-hour film that is PAUSED burns battery for
      // nothing. Play/seek events (and a cue-file load) restart or repaint.
      if (videoRef.current?.paused) {
        frame = null;
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    const resume = () => {
      update();
      if (frame === null) frame = requestAnimationFrame(tick);
    };
    // Lets the cue-loading effect force one repaint while paused.
    refreshCueRef.current = update;
    const video = videoRef.current;
    video?.addEventListener('play', resume);
    // A paused seek must still refresh the visible cue once.
    video?.addEventListener('seeked', resume);
    frame = requestAnimationFrame(tick);
    return () => {
      refreshCueRef.current = () => undefined;
      video?.removeEventListener('play', resume);
      video?.removeEventListener('seeked', resume);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [activeSubtitleId]);

  // Framing scales the video layer inside the overflow-hidden player box —
  // the same instant trick zoom extensions use, but native. Fit is the
  // untouched layout; fill modes crop the empty axis; Auto canvas-samples
  // the frame and crops only genuine black bars, never picture content.
  //
  // Auto deliberately over-cautious: dark scenes make naive bar detectors
  // flap constantly. So bars must be a real thickness, targets within 4% of
  // the current zoom are ignored entirely, and a new target only applies
  // after it repeats on consecutive samples (~3s of agreement). Geometry
  // changes (resize, fullscreen) skip the voting — they are not guesses.
  const appliedScaleRef = useRef(1);
  useEffect(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    /** Displayed size under contain-fit, plus both full-fill scales. */
    const metrics = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (!vw || !vh || !cw || !ch) return null;
      const videoAspect = vw / vh;
      const boxAspect = cw / ch;
      // Contain-fit: width-bound when the video is relatively wider.
      const shownWidth = videoAspect >= boxAspect ? cw : ch * videoAspect;
      const shownHeight = videoAspect >= boxAspect ? cw / videoAspect : ch;
      // Pixels-per-source-height for contain layout (also = scale 1).
      const base = Math.min(cw / videoAspect, ch);
      return { base, fillWidth: cw / shownWidth, fillHeight: ch / shownHeight };
    };

    const apply = (scale: number, animate = false) => {
      const safe = Number.isFinite(scale) ? Math.min(Math.max(scale, 1), 4) : 1;
      appliedScaleRef.current = safe;
      video.style.transformOrigin = 'center';
      video.style.transition = animate ? 'transform 450ms ease' : '';
      video.style.transform = safe === 1 ? '' : `scale(${safe})`;
    };

    /** Fractions of edge rows/columns that are uniform near-black bars, or
     *  null when sampling is impossible (cross-origin taint, no data yet).
     *  Runs thinner than 2% of the frame are discarded as noise. */
    const sampleBars = () => {
      try {
        if (!video.videoWidth) return null;
        const w = 96;
        const h = Math.max(2, Math.round(w / (video.videoWidth / video.videoHeight)));
        const minRun = Math.max(2, Math.round(Math.min(w, h) * 0.02));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(video, 0, 0, w, h);
        const { data } = context.getImageData(0, 0, w, h);
        const bright = (index: number) =>
          0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2] > 26;
        const rowHasContent = (y: number) => {
          for (let x = 0; x < w; x += 1) if (bright((y * w + x) * 4)) return true;
          return false;
        };
        const colHasContent = (x: number) => {
          for (let y = 0; y < h; y += 1) if (bright((y * w + x) * 4)) return true;
          return false;
        };
        let top = 0;
        while (top < h / 2 && !rowHasContent(top)) top += 1;
        let bottom = 0;
        while (bottom < h / 2 && !rowHasContent(h - 1 - bottom)) bottom += 1;
        let left = 0;
        while (left < w / 2 && !colHasContent(left)) left += 1;
        let right = 0;
        while (right < w / 2 && !colHasContent(w - 1 - right)) right += 1;
        return {
          vBars: top >= minRun || bottom >= minRun ? (top + bottom) / h : 0,
          hBars: left >= minRun || right >= minRun ? (left + right) / w : 0,
        };
      } catch {
        return null;
      }
    };

    const update = (immediate = false) => {
      if (framing === 'fit') {
        apply(1);
        return;
      }
      const m = metrics();
      if (!m) return;
      if (framing === 'fill-width') {
        apply(m.fillWidth);
        return;
      }
      if (framing === 'fill-height') {
        apply(m.fillHeight);
        return;
      }
      // Auto: contain-fit the detected content region instead of the whole
      // frame. With no detectable bars this lands exactly on scale 1.
      let scale = 1;
      const bars = sampleBars();
      if (bars && (bars.vBars > 0.01 || bars.hBars > 0.01)) {
        const contentWidthUnits = (video.videoWidth / video.videoHeight) * (1 - bars.hBars);
        const contentHeightUnits = 1 - bars.vBars;
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        if (cw && ch && contentWidthUnits > 0 && contentHeightUnits > 0) {
          const contentBase =
            Math.min(cw / contentWidthUnits, ch / contentHeightUnits);
          scale = contentBase / m.base;
        }
      }
      if (Number.isNaN(scale)) return;

      const applied = appliedScaleRef.current;
      if (Math.abs(scale - applied) < 0.04 * applied) {
        autoVotes.votes = 0;
        return;
      }
      if (Math.abs(scale - autoVotes.scale) < 0.01) autoVotes.votes += 1;
      else {
        autoVotes.scale = scale;
        autoVotes.votes = 1;
      }
      if (immediate || autoVotes.votes >= 2) apply(autoVotes.scale, true);
    };

    const autoVotes = { scale: 1, votes: 0 };

    update(true);
    // Geometry changes are facts, not measurements: recompute immediately.
    const onGeometryChange = () => update(true);
    const observer = new ResizeObserver(onGeometryChange);
    observer.observe(container);
    video.addEventListener('loadedmetadata', onGeometryChange);
    video.addEventListener('resize', onGeometryChange);

    // Letterboxing changes scene by scene; re-check periodically in Auto.
    let sampler: number | null = null;
    if (framing === 'auto') {
      sampler = window.setInterval(() => update(false), 1500);
    }

    return () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', onGeometryChange);
      video.removeEventListener('resize', onGeometryChange);
      if (sampler !== null) window.clearInterval(sampler);
      apply(1);
    };
  }, [framing]);

  const captionsOn = activeSubtitleId !== null;
  const toggleCaptions = useCallback(() => {
    if (captionsOn) {
      onPickSubtitle(null);
    } else if (onEnableCaptions) {
      onEnableCaptions();
    } else {
      onPickSubtitle(subtitles[0]?.id ?? null);
    }
  }, [captionsOn, onEnableCaptions, onPickSubtitle, subtitles]);


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
      void video.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
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
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        void video.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
      });
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
    if (!settingsOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setSettingsOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutside);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [settingsOpen]);

  const keepControls = settingsOpen || !playing || blocked;

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
    // WKWebView in the desktop shell doesn't implement element fullscreen —
    // toggle the native window instead (also feels more at home on desktop).
    if (isDesktopRuntime()) {
      void (async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const appWindow = getCurrentWindow();
          const next = !(await appWindow.isFullscreen());
          await appWindow.setFullscreen(next);
          setFullscreen(next);
        } catch {
          // Missing permission or non-Tauri context; nothing to do.
        }
      })();
      return;
    }
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
        case 'c':
          event.preventDefault();
          toggleCaptions();
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
  }, [togglePlay, seekBy, toggleMute, toggleFullscreen, toggleCaptions, revealControls]);

  // One-shot catch-up after a seek restart: the new playlist begins at the
  // keyframe ffmpeg landed on (earlier than requested), so close the gap by
  // seeking locally as soon as the source can seek. Reset per source.
  useEffect(() => {
    localSeekApplied.current = null;
  }, [src]);

  useEffect(() => {
    if (startTimeLocal == null || startTimeLocal < 0.25) return;
    if (localSeekApplied.current === src) return;
    const video = videoRef.current;
    if (!video || video.seekable.length === 0) return;
    localSeekApplied.current = src;
    const seekableEnd = Math.max(0, video.seekable.end(video.seekable.length - 1) - 0.5);
    video.currentTime = Math.min(startTimeLocal, seekableEnd);
  }, [startTimeLocal, src, currentTime]);

  function syncBuffered(video: HTMLVideoElement) {
    const ranges = video.buffered;
    const nextRanges: BufferedRange[] = [];
    for (let index = 0; index < ranges.length; index += 1) {
      nextRanges.push({ start: ranges.start(index), end: ranges.end(index) });
    }
    // Buffered ranges rarely change; returning the previous reference lets
    // React bail out instead of re-rendering the whole player.
    setBufferedRanges((previous) => {
      if (
        previous.length === nextRanges.length &&
        previous.every(
          (range, index) =>
            range.start === nextRanges[index].start && range.end === nextRanges[index].end,
        )
      ) {
        return previous;
      }
      return nextRanges;
    });
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
  const captionHex =
    CAPTION_COLORS.find((entry) => entry.value === captionColor)?.hex ?? '#ffffff';

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
        }}        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
        onError={onError}
      />

      {waiting && !blocked ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40">
          <LogoLoader title={title} progress={null} size="sm" logoPath={logoPath} />
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
        className={`pointer-events-none absolute inset-x-0 top-0 flex items-start justify-start bg-linear-to-b from-black/80 via-black/30 to-transparent px-4 pb-12 pt-4 transition-opacity duration-300 sm:px-6 ${
          controlsVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <button
          type="button"
          onClick={goBack}
          className="desktop-back-offset pointer-events-auto flex min-w-0 max-w-full cursor-pointer items-center gap-3 text-left text-white transition-colors hover:text-white/80"
        >
          <IoIosArrowBack size={26} className="shrink-0 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
          <span className="min-w-0 text-left">
            <span className="block truncate font-semibold">{title}</span>
            {subtitle ? (
              <span className="block truncate text-sm text-white/45">{subtitle}</span>
            ) : null}
          </span>
        </button>

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
            <ControlButton
              label={captionsOn ? 'Turn off captions' : 'Turn on captions'}
              onClick={toggleCaptions}
            >
              {captionsOn ? <MdClosedCaption size={21} /> : <MdClosedCaptionOff size={21} />}
            </ControlButton>

            <div ref={settingsRef} className="relative">
              <ControlButton
                label="Playback settings"
                onClick={() => {
                  setSettingsOpen((open) => !open);
                }}
              >
                <IoSettingsSharp size={20} />
              </ControlButton>
              {settingsOpen ? (
                <PlayerSettings
                  subtitles={subtitles}
                  activeSubtitleId={activeSubtitleId}
                  onPickSubtitle={onPickSubtitle}
                  captionSize={captionSize}
                  onPickCaptionSize={onPickCaptionSize}
                  captionColor={captionColor}
                  onPickCaptionColor={onPickCaptionColor}
                  framing={framing}
                  onPickFraming={pickFraming}
                />
              ) : null}
            </div>

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
                <MdPictureInPictureAlt size={22} />
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

      {/* Subtitle overlay — Cubo-rendered instead of native tracks so cues
          stay aligned with absolute movie time and can be styled freely.
          Sits low by default and eases up above the controls while shown. */}
      {activeCueText ? (
        <div
          aria-live="off"
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-[8%] transition-transform duration-300 ease-out ${
            controlsVisible ? '-translate-y-[7.5rem]' : '-translate-y-[6.5rem]'
          }`}
        >
          <span
            className={`whitespace-pre-line text-center font-medium leading-snug [text-shadow:0_1px_2px_rgba(0,0,0,0.9),0_0_12px_rgba(0,0,0,0.6)] ${
              captionSize === 'small'
                ? '[font-size:clamp(0.95rem,0.95rem+1vh,1.5rem)]'
                : captionSize === 'large'
                  ? '[font-size:clamp(1.5rem,1.5rem+1.7vh,2.6rem)]'
                  : '[font-size:clamp(1.2rem,1.2rem+1.35vh,2.1rem)]'
            }`}
            style={{ color: captionHex }}
          >
            {activeCueText}
          </span>
        </div>
      ) : null}
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
