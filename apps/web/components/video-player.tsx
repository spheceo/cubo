/** Cubo's player for direct files and Core's complete VOD HLS playlists. */
import { watchableSpan } from '@/lib/download-bar';
import {
  IoContract,
  IoExpand,
  IoPause,
  IoPlay,
  IoPlayBack,
  IoPlayForward,
  IoPlaySkipForward,
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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type MutableRefObject, type RefObject } from 'react';
import type { CaptionColor, CaptionSize } from '@/lib/caption-prefs';
import { CAPTION_COLORS } from '@/lib/caption-prefs';
import {
  loadFramingPref,
  saveFramingPref,
  type FramingMode,
} from '@/lib/framing-prefs';
import { cancelAutoplayUnmute, playInBackground } from '@/lib/background-playback';
import {
  loadSectionPrefs,
  saveSectionPrefs,
  sectionColorMap,
  SECTION_FALLBACK_COLOR,
  type SectionKind,
  type SectionPrefs,
} from '@/lib/section-prefs';
import { logoUrl } from '@cubo/core';
import { findActiveCue, loadSubtitleCues, type SubtitleCue } from '@/lib/subtitles';
import { LogoLoader } from './logo-loader';
import { PlayerSettings } from './player-settings';
import { isAdvancingPlayback } from '@/lib/player-readiness';
import { formatTime } from '@/lib/format';
import { sessionHlsConfig } from '@/lib/session-hls-config';
import type { SkipSection } from '@/lib/local-engine';

const HIDE_DELAY_MS = 2600;
const SKIP_SECONDS = 10;
/** Seconds the Next episode fill takes to complete before auto-advancing. */
const AUTO_NEXT_MS = 6_000;

export type BufferedRange = {
  start: number;
  end: number;
};

/** True when `time` sits inside a buffered range. */
function timeRangesCover(ranges: TimeRanges, time: number, slack = 0.35): boolean {
  for (let index = 0; index < ranges.length; index += 1) {
    if (time >= ranges.start(index) - slack && time <= ranges.end(index) + slack) {
      return true;
    }
  }
  return false;
}

export type PlayerSubtitle = {
  id: string;
  src: string;
  language: string;
  label: string;
};

export function VideoPlayer({
  fullscreenTargetRef,
  src,
  hls = false,
  durationHint = null,
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
  onPlaybackProgress,
  onSeekIntent,
  onPlaying,
  onError,
  onStall,
  downloadedRanges = null,
  flushRef,
  topRightControls,
  introWindow,
  creditsWindow,
  onNextEpisode,
  onCreditsReached,
  sections,
  audioOptions,
  activeAudio,
  onPickAudio,
}: {
  fullscreenTargetRef: RefObject<HTMLDivElement | null>;
  topRightControls?: ReactNode;
  /** Detected intro window in absolute source seconds. A Skip intro button
   *  shows while the playhead is inside it; `end` null means unbounded. */
  introWindow?: { start: number; end: number | null } | null;
  /** Detected credits/outro window in absolute source seconds. */
  creditsWindow?: { start: number; end: number | null } | null;
  /** Offered during the credits window when a follow-up episode exists;
   *  without one the credits action leaves the player instead. */
  onNextEpisode?: () => void;
  /** Fired once when the playhead first enters the credits window. */
  onCreditsReached?: () => void;
  /** Every classified section, drawn as colored bands on the scrub bar. */
  sections?: SkipSection[];
  /** Audio languages on offer (original / English dub). Picking one
   *  restarts playback on the parent's side. */
  audioOptions?: { value: string; label: string }[];
  activeAudio?: string;
  onPickAudio?: (value: string) => void;
  src: string;
  /** True when `src` is a Core VOD HLS playlist. */
  hls?: boolean;
  /** Full source duration reported by Core. */
  durationHint?: number | null;
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
  captionColor?: CaptionColor;
  onPickCaptionColor: (color: CaptionColor) => void;
  onPlaybackProgress: (
    positionSeconds: number,
    durationSeconds: number,
    watchedDeltaSeconds: number,
    sessionStarted: boolean,
    persistNow?: boolean,
  ) => void;
  /** Persist an intentional jump before asynchronous seeking begins. */
  onSeekIntent?: (absoluteSeconds: number) => void;
  onError: () => void;
  onPlaying?: () => void;
  /** A mid-playback buffering pause ended (not startup, seeks or pauses). */
  onStall?: (stall: { positionSeconds: number; durationMs: number }) => void;
  /** Absolute stretches Core has on disk. When given, the bar draws the
   *  watchable span from the playhead instead of the browser's buffered
   *  ranges: for direct files the browser only knows bytes and places them
   *  as if the bitrate were constant. */
  downloadedRanges?: BufferedRange[] | null;
  /** Parent calls this before leaving so progress is snapshotted while the
   *  video element still has a real currentTime. */
  flushRef?: MutableRefObject<(() => void) | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  /** The pointer shows while it moves, even when the chrome stays down
   *  (the credits takeover), and hides again after the same idle delay. */
  const [cursorVisible, setCursorVisible] = useState(true);
  const cursorTimer = useRef<number | null>(null);
  const scrubFrame = useRef<number | null>(null);
  const pendingScrubRatio = useRef(0);
  const scrubbing = useRef(false);
  const initialSeekApplied = useRef(false);
  const lastObservedTime = useRef<number | null>(null);
  const lastProgressReport = useRef(0);
  const lastProgressWallTime = useRef(0);
  const sessionReported = useRef(false);
  /** Set by the first `playing` of the current source; stalls before it are
   *  startup, not interruptions. */
  const playedSinceSource = useRef(false);
  const stallRef = useRef<{ startedAt: number; position: number } | null>(null);
  /** False only when the viewer hit pause — browsers pausing a hidden tab
   *  must not stick. A new source starts unpaused. */
  const userPaused = useRef(false);
  /** Bumps to cancel an in-flight hidden-tab play() retry loop. */
  const playGeneration = useRef(0);
  /** Prevent a teardown/attach pause from immediately restarting playback. */
  const sourceReadyRef = useRef(false);

  // Framing preference is player-global (like a TV picture-size setting):
  // it follows the viewer across titles, so the player owns it directly.
  const [framing, setFraming] = useState<FramingMode>(() => loadFramingPref());
  const pickFraming = useCallback((mode: FramingMode) => {
    setFraming(mode);
    saveFramingPref(mode);
  }, []);

  // Section markers on the timeline are a viewer pref like framing —
  // detection and skip actions are unaffected, this only hides the bands.
  const [sectionPrefs, setSectionPrefs] = useState<SectionPrefs>(() => loadSectionPrefs());
  const showSections = sectionPrefs.visible;
  const sectionColors = useMemo(() => sectionColorMap(sectionPrefs), [sectionPrefs]);
  const toggleSections = useCallback((visible: boolean) => {
    setSectionPrefs((prev) => {
      const next = { ...prev, visible };
      saveSectionPrefs(next);
      return next;
    });
  }, []);
  const pickSectionColor = useCallback((kind: SectionKind, color: string) => {
    setSectionPrefs((prev) => {
      const next = { ...prev, colors: { ...prev.colors, [kind]: color } };
      saveSectionPrefs(next);
      return next;
    });
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
  const [heldPaused, setHeldPaused] = useState(false);
  /** Absolute time the viewer asked for. Held until the source can actually
   *  sit there, so the needle does not snap back to the converted window. */
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  /** One currentTime write per held seek — never a servo. */
  const pendingSeekKickedRef = useRef(false);
  /** Viewer mute, as opposed to the autoplay-policy mute. */
  const userMutedRef = useRef(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedRanges, setBufferedRanges] = useState<BufferedRange[]>([]);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(() => Boolean(document.fullscreenElement));
  const [controlsVisible, setControlsVisible] = useState(true);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [pipSupported, setPipSupported] = useState(false);
  const [activeCueText, setActiveCueText] = useState<string | null>(null);

  useEffect(() => setPipSupported(document.pictureInPictureEnabled), []);

  // Callbacks live in refs so the media-source effect and stable seek helpers
  // never go stale or rerun on unrelated renders.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onStallRef = useRef(onStall);
  onStallRef.current = onStall;
  /** Read once per source by the session hls.js setup (its start position). */
  const initialTimeRef = useRef(initialTime);
  initialTimeRef.current = initialTime;
  // Subtitles are rendered by Cubo, not the browser's native track layer:
  // session playlists and cues both use absolute movie time.
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
      const cue = findActiveCue(cues, video.currentTime);
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

  const markUserPaused = useCallback((paused: boolean) => {
    userPaused.current = paused;
    setHeldPaused(paused);
  }, []);

  const requestPlay = useCallback((video: HTMLVideoElement) => {
    if (userPaused.current || video.ended) return;
    const generation = ++playGeneration.current;
    void playInBackground(
      video,
      () => userPaused.current || playGeneration.current !== generation,
      setBlocked,
      () => userMutedRef.current,
    );
  }, []);

  const stopPlayLoop = useCallback(() => {
    playGeneration.current += 1;
  }, []);

  const holdSeek = useCallback((absoluteSeconds: number) => {
    pendingSeekRef.current = absoluteSeconds;
    pendingSeekKickedRef.current = false;
    setPendingSeek(absoluteSeconds);
  }, []);

  const clearPendingSeek = useCallback(() => {
    pendingSeekRef.current = null;
    pendingSeekKickedRef.current = false;
    setPendingSeek(null);
  }, []);

  const applyPendingSeek = useCallback(
    (video: HTMLVideoElement) => {
      const pending = pendingSeekRef.current;
      if (pending == null) return;
      const local = Math.max(0, pending);
      const actual = video.currentTime;

      if (Math.abs(actual - pending) < 1.25) {
        clearPendingSeek();
        return;
      }

      if (pendingSeekKickedRef.current) return;
      if (!timeRangesCover(video.buffered, local)) return;
      pendingSeekKickedRef.current = true;
      video.currentTime = local;
    },
    [clearPendingSeek],
  );

  useEffect(() => {
    initialSeekApplied.current = false;
    lastObservedTime.current = null;
    setDuration(hls && durationHint && Number.isFinite(durationHint) ? durationHint : 0);
    setCurrentTime(0);
    setBufferedRanges([]);
    setWaiting(true);
    setBlocked(false);
    markUserPaused(false);
    pendingSeekRef.current = null;
    pendingSeekKickedRef.current = false;
    setPendingSeek(null);
    playedSinceSource.current = false;
    stallRef.current = null;
  }, [src, hls, durationHint, markUserPaused]);

  // Mid-playback buffering, for diagnostics: a wait that begins while the
  // source was playing normally. Startup loads, seeks and pauses are not
  // stalls; a seek that starts during one discards it.
  useEffect(() => {
    if (pendingSeek != null || heldPaused) {
      stallRef.current = null;
      return;
    }
    const video = videoRef.current;
    if (waiting) {
      if (video && !stallRef.current && playedSinceSource.current) {
        stallRef.current = {
          startedAt: performance.now(),
          position: video.currentTime,
        };
      }
      return;
    }
    const stall = stallRef.current;
    stallRef.current = null;
    if (!stall) return;
    const durationMs = performance.now() - stall.startedAt;
    if (durationMs >= 250) {
      onStallRef.current?.({ positionSeconds: stall.position, durationMs });
    }
  }, [waiting, pendingSeek, heldPaused]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    sourceReadyRef.current = false;
    let cancelled = false;
    const start = () => {
      if (cancelled || userPaused.current) return;
      requestPlay(video);
    };

    if (!hls) {
      video.src = src;
      sourceReadyRef.current = true;
      start();
      return () => {
        cancelled = true;
        sourceReadyRef.current = false;
        stopPlayLoop();
        video.removeAttribute('src');
      };
    }

    // Keep remuxed sources on hls.js so every browser uses the same VOD seek
    // and segment request policy.
    let instance: import('hls.js').default | null = null;
    void import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) {
        onErrorRef.current();
        return;
      }
      instance = new Hls(sessionHlsConfig(initialTimeRef.current));
      instance.loadSource(src);
      instance.attachMedia(video);
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        sourceReadyRef.current = true;
        start();
      });
      // hls.js already retried the request policy; one more round of
      // recovery before telling the owner, who asks Core what happened.
      let networkRecoveries = 0;
      let mediaRecoveries = 0;
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || !instance) return;
        const gone = data.response?.code === 404 || data.response?.code === 410;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !gone && networkRecoveries < 2) {
          networkRecoveries += 1;
          instance.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
          mediaRecoveries += 1;
          instance.recoverMediaError();
          return;
        }
        onErrorRef.current();
      });
    });

    return () => {
      cancelled = true;
      sourceReadyRef.current = false;
      stopPlayLoop();
      instance?.destroy();
    };
  }, [src, hls, requestPlay, stopPlayLoop]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const resumeIfNeeded = () => {
      if (userPaused.current || !video.paused || video.ended) {
        return;
      }
      requestPlay(video);
    };
    document.addEventListener('visibilitychange', resumeIfNeeded);
    window.addEventListener('pageshow', resumeIfNeeded);
    return () => {
      document.removeEventListener('visibilitychange', resumeIfNeeded);
      window.removeEventListener('pageshow', resumeIfNeeded);
    };
  }, [src, requestPlay]);

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

  const shownTime = scrubTime ?? pendingSeek ?? currentTime;

  const [creditsDismissed, setCreditsDismissed] = useState(false);
  // An intro with no known end cannot be skipped — nothing to offer.
  const inIntro =
    introWindow != null &&
    introWindow.end != null &&
    shownTime >= introWindow.start &&
    shownTime < introWindow.end;
  const inCredits =
    creditsWindow != null &&
    shownTime >= creditsWindow.start &&
    shownTime < (creditsWindow.end ?? Number.POSITIVE_INFINITY);
  // A dismissed credits prompt re-arms once the playhead leaves the window,
  // so rewinding back into it offers the actions again.
  useEffect(() => {
    if (!inCredits) setCreditsDismissed(false);
  }, [inCredits]);

  // The intro skipper gets one standalone reveal per window entry — it shows
  // on its own when the intro starts, no controls needed. Once the viewer
  // has raised the chrome inside the window, it binds to the controls:
  // fades out with them and only comes back on a manual raise.
  const [introControlsSeen, setIntroControlsSeen] = useState(false);
  useEffect(() => {
    if (inIntro && controlsVisible) setIntroControlsSeen(true);
    if (!inIntro) setIntroControlsSeen(false);
  }, [inIntro, controlsVisible]);
  const showIntroSkip = inIntro && (controlsVisible || !introControlsSeen);

  // The credits window is a takeover: the skip elements own the frame and
  // the chrome cannot be raised until the viewer picks Watch credits (or
  // the window ends). Clicking the video still plays/pauses — only the
  // controls bar is suppressed.
  const creditsTakeover = inCredits && !creditsDismissed;
  const creditsTakeoverRef = useRef(creditsTakeover);
  creditsTakeoverRef.current = creditsTakeover;
  const keepControls = !creditsTakeover && (settingsOpen || heldPaused || blocked);
  useEffect(() => {
    if (!creditsTakeover) return;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    setControlsVisible(false);
  }, [creditsTakeover]);

  // Reaching the credits marks the title watched — a movie leaves Continue
  // Watching here, an episode counts as done even without the last frame.
  const onCreditsReachedRef = useRef(onCreditsReached);
  onCreditsReachedRef.current = onCreditsReached;
  const creditsMarkedRef = useRef(false);
  useEffect(() => {
    if (inCredits && !creditsMarkedRef.current) {
      creditsMarkedRef.current = true;
      onCreditsReachedRef.current?.();
    }
    if (!inCredits) creditsMarkedRef.current = false;
  }, [inCredits]);

  // Next episode countdown — the fill sweep doubles as the timer. Driven by
  // rAF writing a scaleX transform straight onto the node: compositor-smooth
  // and zero re-renders. Pausing freezes it; completing it auto-advances.
  const nextFillRef = useRef<HTMLSpanElement | null>(null);
  const nextFillPos = useRef(0);
  const nextFired = useRef(false);
  useEffect(() => {
    if (creditsTakeover) return;
    nextFillPos.current = 0;
    nextFired.current = false;
    if (nextFillRef.current) nextFillRef.current.style.transform = 'scaleX(0)';
  }, [creditsTakeover]);
  useEffect(() => {
    if (!creditsTakeover || !onNextEpisode || !playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      nextFillPos.current = Math.min(1, nextFillPos.current + (now - last) / AUTO_NEXT_MS);
      last = now;
      if (nextFillRef.current) nextFillRef.current.style.transform = `scaleX(${nextFillPos.current})`;
      if (nextFillPos.current >= 1) {
        if (!nextFired.current) {
          nextFired.current = true;
          onNextEpisode();
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [creditsTakeover, onNextEpisode, playing]);

  const revealControls = useCallback(() => {
    setCursorVisible(true);
    if (cursorTimer.current) window.clearTimeout(cursorTimer.current);
    cursorTimer.current = window.setTimeout(() => setCursorVisible(false), HIDE_DELAY_MS);
    // No chrome during the credits takeover — a click still toggles play,
    // but only Watch credits gives the controls back.
    if (creditsTakeoverRef.current) return;
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
      if (cursorTimer.current) window.clearTimeout(cursorTimer.current);
      if (scrubFrame.current) window.cancelAnimationFrame(scrubFrame.current);
    },
    [],
  );


  const reportPlayback = useCallback(
    (sessionStarted = false, persistNow = false) => {
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
        pendingSeekRef.current ?? video.currentTime,
        fullDuration,
        watchedDelta,
        sessionStarted,
        persistNow,
      );
    },
    [onPlaybackProgress, resolveDuration],
  );

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = () => reportPlayback(false, true);
    return () => {
      flushRef.current = null;
    };
  }, [flushRef, reportPlayback]);

  useEffect(() => {
    const flush = () => reportPlayback(false, true);
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onHidden);
      flush();
    };
  }, [reportPlayback]);

  // Pause, back, hide, and unmount all flush on their own — this interval is
  // the backstop so a crash or killed tab loses at most ~30 s of position.
  useEffect(() => {
    const interval = window.setInterval(() => reportPlayback(false, true), 30_000);
    return () => window.clearInterval(interval);
  }, [reportPlayback]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      markUserPaused(false);
      requestPlay(video);
    } else {
      markUserPaused(true);
      stopPlayLoop();
      video.pause();
    }
  }, [markUserPaused, requestPlay, stopPlayLoop]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const artwork = logoPath
      ? [{ src: logoUrl(logoPath, 'w300'), sizes: '300x300', type: 'image/png' }]
      : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: subtitle ?? 'Cubo',
      artwork,
    });
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    navigator.mediaSession.setActionHandler('play', () => {
      markUserPaused(false);
      const video = videoRef.current;
      if (video) requestPlay(video);
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      markUserPaused(true);
      stopPlayLoop();
      videoRef.current?.pause();
    });
    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
    };
  }, [title, subtitle, logoPath, playing, markUserPaused, requestPlay, stopPlayLoop]);

  /** Seeks to an absolute source position and holds the needle there while
   *  that section buffers. */
  const seekToAbsolute = useCallback(
    (absoluteSeconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      const fullDuration = resolveDuration(video);
      const target = Math.max(
        0,
        fullDuration > 0 ? Math.min(fullDuration, absoluteSeconds) : absoluteSeconds,
      );
      onSeekIntent?.(target);
      holdSeek(target);
      setCurrentTime(target);
      pendingSeekKickedRef.current = true;
      video.currentTime = target;
    },
    [holdSeek, resolveDuration, onSeekIntent],
  );

  const seekBy = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const fullDuration = resolveDuration(video);
    const head = pendingSeekRef.current ?? video.currentTime;
    seekToAbsolute(Math.max(0, Math.min(fullDuration || Infinity, head + seconds)));
    revealControls();
  }, [resolveDuration, revealControls, seekToAbsolute]);

  const focusPlayer = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && containerRef.current?.contains(active)) {
      active.blur();
    }
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void fullscreenTargetRef.current?.requestFullscreen().catch(() => undefined);
  }, [fullscreenTargetRef]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const next = !video.muted;
    video.muted = next;
    userMutedRef.current = next;
    if (next) cancelAutoplayUnmute();
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(Boolean(document.fullscreenElement));
      // Browsers put focus back on the fullscreen button after enter/exit.
      // Defer so we win that restore — otherwise Space/ArrowLeft hit the
      // button instead of the player.
      focusPlayer();
      requestAnimationFrame(() => {
        focusPlayer();
        window.setTimeout(focusPlayer, 0);
      });
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [focusPlayer]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // The episode drawer owns keyboard navigation and Escape. Do not let
      // player shortcuts seek, toggle playback, or navigate back underneath it.
      if (document.querySelector('dialog[data-player-episodes][open]')) return;
      if (target?.closest('input, select, textarea, [contenteditable="true"]')) {
        return;
      }
      if (settingsOpen && target && settingsRef.current?.contains(target)) {
        return;
      }

      const video = videoRef.current;
      if (!video) return;

      const take = () => {
        event.preventDefault();
        focusPlayer();
      };

      switch (event.key) {
        case ' ':
        case 'k':
          take();
          togglePlay();
          break;
        case 'ArrowLeft':
          take();
          seekBy(-SKIP_SECONDS);
          break;
        case 'ArrowRight':
          take();
          seekBy(SKIP_SECONDS);
          break;
        case 'ArrowUp':
          take();
          video.volume = Math.min(1, video.volume + 0.1);
          revealControls();
          break;
        case 'ArrowDown':
          take();
          video.volume = Math.max(0, video.volume - 0.1);
          revealControls();
          break;
        case 'm':
          take();
          toggleMute();
          break;
        case 'c':
          take();
          toggleCaptions();
          break;
        case 'f':
          take();
          toggleFullscreen();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    settingsOpen,
    focusPlayer,
    togglePlay,
    seekBy,
    toggleMute,
    toggleFullscreen,
    toggleCaptions,
    revealControls,
  ]);

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

  const playedRatio = duration ? Math.min(1, shownTime / duration) : 0;
  const volumeLevel = muted || volume === 0 ? 'muted' : volume < 0.5 ? 'low' : 'high';
  const captionHex =
    CAPTION_COLORS.find((entry) => entry.value === captionColor)?.hex ?? '#ffffff';

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onPointerMove={revealControls}
      onPointerLeave={() => !keepControls && setControlsVisible(false)}
      className={`group/player relative h-full w-full overflow-hidden bg-black outline-none ${
        controlsVisible || cursorVisible || keepControls ? '' : 'cursor-none'
      }`}
    >
      {topRightControls ? (
        <div
          className={`pointer-events-none absolute inset-0 z-20 transition-opacity duration-300 ${
            controlsVisible ? 'opacity-100' : 'invisible opacity-0'
          }`}
        >
          {topRightControls}
        </div>
      ) : null}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        preload="auto"
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
          reportPlayback(false, true);
          const video = videoRef.current;
          if (
            video?.isConnected &&
            !userPaused.current &&
            sourceReadyRef.current &&
            !video.ended
          ) {
            requestPlay(video);
          }
        }}
        onWaiting={() => {
          if (!userPaused.current) setWaiting(true);
        }}
        onPlaying={(event) => {
          playedSinceSource.current = true;
          syncBuffered(event.currentTarget);
          applyPendingSeek(event.currentTarget);
          setWaiting(false);
          onPlaying?.();
        }}
        onCanPlay={(event) => {
          const video = event.currentTarget;
          syncBuffered(video);
          applyPendingSeek(video);
          if (!userPaused.current && video.paused) {
            requestPlay(video);
          }
          if (!video.paused) setWaiting(false);
        }}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          syncBuffered(video);
          if (isAdvancingPlayback(lastObservedTime.current, video)) setWaiting(false);
          lastObservedTime.current = video.currentTime;
          applyPendingSeek(video);
          if (pendingSeekRef.current == null) {
            setCurrentTime(video.currentTime);
          }
          if (performance.now() - lastProgressReport.current >= 1_000) {
            reportPlayback(false);
          }
        }}
        onSeeked={(event) => {
          const video = event.currentTarget;
          syncBuffered(video);
          applyPendingSeek(video);
          if (pendingSeekRef.current == null) setCurrentTime(video.currentTime);
          lastObservedTime.current = video.currentTime;
        }}
        onProgress={(event) => {
          syncBuffered(event.currentTarget);
          applyPendingSeek(event.currentTarget);
        }}
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
            holdSeek(initialTime);
            // Direct MP4/WebM seeks initiate HTTP range reads. Waiting for
            // this position to be buffered first plays from zero beneath
            // a permanently pending resume overlay on some sources.
            pendingSeekKickedRef.current = true;
            video.currentTime = initialTime;
            requestPlay(video);
          }
        }}
        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
        onError={onError}
      />

      {(waiting || pendingSeek != null) && !blocked && !heldPaused ? (
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

      {/* Skip elements — intro/outro actions tied to detected windows. They
          sit at the bottom of the frame and slide up when the chrome is up.
          The intro skipper reveals itself once on window entry, then binds
          to the controls. The credits elements are a takeover that keeps the
          chrome down until a choice is made. */}
      {inIntro && introWindow?.end != null ? (
        <div
          className={`absolute right-4 z-20 transition-[bottom,opacity] duration-300 sm:right-6 ${
            showIntroSkip
              ? controlsVisible
                ? 'bottom-24'
                : 'bottom-6'
              : 'pointer-events-none bottom-6 opacity-0'
          }`}
        >
          <button
            type="button"
            onClick={() => {
              const end = introWindow?.end;
              if (end != null) seekToAbsolute(end);
            }}
            className="flex cursor-pointer items-center gap-2 rounded-full bg-white px-4 py-2 text-[0.8rem] font-medium text-black transition-colors hover:bg-white/85"
          >
            Skip intro
            <IoPlaySkipForward size={15} aria-hidden />
          </button>
        </div>
      ) : null}
      {creditsTakeover && creditsWindow ? (
        <div
          className={`absolute right-4 z-20 flex items-center gap-3 transition-[bottom] duration-300 sm:right-6 ${
            controlsVisible ? 'bottom-24' : 'bottom-6'
          }`}
        >
          <button
            type="button"
            onClick={() => setCreditsDismissed(true)}
            className="cursor-pointer rounded-full border border-white/30 bg-black/60 px-3.5 py-2 text-[0.8rem] font-medium text-white/90 backdrop-blur-md transition-colors hover:border-white/50 hover:text-white"
          >
            Watch credits
          </button>
          <button
            type="button"
            onClick={() => {
              // With nothing to play next (a movie, a finale), the title is
              // done: leave the player instead of parking on the last frame.
              if (onNextEpisode) onNextEpisode();
              else goBack();
            }}
            className={`relative isolate flex cursor-pointer items-center gap-2 overflow-hidden rounded-full px-4 py-2 text-[0.8rem] font-medium text-black transition-colors ${
              onNextEpisode ? 'bg-white/70' : 'bg-white hover:bg-white/85'
            }`}
          >
            {onNextEpisode ? (
              <span
                aria-hidden
                ref={nextFillRef}
                className="absolute inset-0 origin-left bg-white"
                style={{ transform: 'scaleX(0)' }}
              />
            ) : null}
            <span className="relative">{onNextEpisode ? 'Next episode' : 'Back to browsing'}</span>
            {onNextEpisode ? (
              <IoPlaySkipForward size={15} className="relative" aria-hidden />
            ) : null}
          </button>
        </div>
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
          className="pointer-events-auto flex min-w-0 max-w-full cursor-pointer items-center gap-3 text-left text-white transition-colors hover:text-white/80"
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
          <div ref={barRef} className="relative h-[5px] w-full rounded-full bg-white/15">
            {duration > 0
              ? (downloadedRanges ? watchableSpan(downloadedRanges, shownTime) : bufferedRanges).map((range, index) => {
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
            {/* Section bands sit under the played fill — once the playhead
                passes a section, the progress bar covers it. Generic chapter
                markers never draw; only named sections earn a band. */}
            {showSections && duration > 0
              ? sections
                  ?.filter((section) => section.kind !== 'chapter')
                  .map((section, index) => {
                    const end = section.end ?? duration;
                    const left = Math.max(0, Math.min(1, section.start / duration));
                    const width = Math.max(
                      0.004,
                      Math.min(1, Math.min(end, duration) / duration) - left,
                    );
                    return (
                      <span
                        key={`${section.kind}-${index}`}
                        aria-hidden="true"
                        className="absolute inset-y-0 rounded-full"
                        style={{
                          left: `${left * 100}%`,
                          width: `${width * 100}%`,
                          background:
                            sectionColors[section.kind as SectionKind] ??
                            SECTION_FALLBACK_COLOR,
                        }}
                      />
                    );
                  })
              : null}
            {/* Clipped rather than scaled: scaleX squashes the rounded
                end flat, a rounded inset keeps it a full pill. */}
            <div
              className="absolute inset-0 rounded-full bg-accent will-change-[clip-path]"
              style={{ clipPath: `inset(0 ${(1 - playedRatio) * 100}% 0 0 round 9999px)` }}
            />
            {/* Hover highlight — repaints the hovered section above the
                played fill so its color reads even in watched territory.
                Always mounted so leaving the region fades it back out. */}
            {showSections && duration > 0
              ? sections
                  ?.filter((section) => section.kind !== 'chapter')
                  .map((section, index) => {
                    const end = section.end ?? duration;
                    const left = Math.max(0, Math.min(1, section.start / duration));
                    const width = Math.max(
                      0.004,
                      Math.min(1, Math.min(end, duration) / duration) - left,
                    );
                    const hovered =
                      hoverRatio != null &&
                      hoverRatio * duration >= section.start &&
                      hoverRatio * duration < end;
                    return (
                      <span
                        key={`hover-${section.kind}-${index}`}
                        aria-hidden="true"
                        className="absolute inset-y-0 rounded-full transition-opacity duration-200"
                        style={{
                          left: `${left * 100}%`,
                          width: `${width * 100}%`,
                          background:
                            sectionColors[section.kind as SectionKind] ??
                            SECTION_FALLBACK_COLOR,
                          opacity: hovered ? 1 : 0,
                        }}
                      />
                    );
                  })
              : null}
            <span
              className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 transition-opacity will-change-[left] group-hover/bar:opacity-100"
              style={{ left: `${playedRatio * 100}%` }}
            />
          </div>

          {hoverRatio !== null && duration ? (
            (() => {
              const hoverTime = hoverRatio * duration;
              // Generic chapter markers ("Part 01", "Scene 2") stay unlabeled
              // — only named sections earn tooltip text, and they win over a
              // generic band the cursor may also be inside.
              const section =
                showSections && sections
                  ? sections.find(
                      (entry) =>
                        entry.kind !== 'chapter' &&
                        hoverTime >= entry.start &&
                        hoverTime < (entry.end ?? duration),
                    )
                  : undefined;
              return (
                <span
                  className="pointer-events-none absolute bottom-7 z-30 -translate-x-1/2 rounded-md bg-black/80 px-2 py-1 text-[0.7rem] tabular-nums text-white will-change-[left]"
                  style={{ left: `${hoverRatio * 100}%` }}
                >
                  {formatTime(hoverTime)}
                  {section ? (
                    <span
                      className="ml-1.5 font-medium"
                      style={{
                        color:
                          sectionColors[section.kind as SectionKind] ??
                          SECTION_FALLBACK_COLOR,
                      }}
                    >
                      {section.label}
                    </span>
                  ) : null}
                </span>
              );
            })()
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
                const nextMuted = Number(event.target.value) === 0;
                video.muted = nextMuted;
                userMutedRef.current = nextMuted;
                if (nextMuted) cancelAutoplayUnmute();
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
                  sectionsVisible={showSections}
                  onToggleSections={toggleSections}
                  sectionColors={sectionColors}
                  onPickSectionColor={pickSectionColor}
                  audioOptions={audioOptions}
                  activeAudio={activeAudio}
                  onPickAudio={(value) => {
                    setSettingsOpen(false);
                    if (value !== activeAudio) onPickAudio?.(value);
                  }}
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
      onClick={(event) => {
        onClick();
        event.currentTarget.blur();
      }}
      aria-label={label}
      title={label}
      className="flex cursor-pointer items-center justify-center rounded-full p-2 text-white/85 transition-colors hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}
