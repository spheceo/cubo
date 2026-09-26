/**
 * Orchestrates playback: source ranking, resume, and mid-play source
 * fallback. Core owns everything
 * about the chosen source (torrent, file, direct vs remux, conversion
 * window) and the client only creates the session, heartbeats its position,
 * and asks Core what went wrong before giving up on a source.
 */
import {
  backdropUrl,
  type MediaType,
  type SeasonSummary,
  type Episode,
  type Stream,
  type SubtitleTrack,
} from '@cubo/core';
import { IoIosArrowBack } from 'react-icons/io';
import { IoClose, IoList } from 'react-icons/io5';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Link } from '@/components/link';
import { Dropdown } from '@/components/dropdown';
import { EpisodeRow } from '@/components/episode-list';
import { apiUrl } from '@/lib/api';
import { isUpcomingAirDate } from '@/lib/air-date';
import { queryClient, streamQueries, tmdbQueries } from '@/lib/queries';
import { useCore } from './core-provider';
import { LogoLoader } from './logo-loader';
import { resetWindowScroll } from './scroll-to-top';
import { watchOrigin } from './watch-origin';
import { VideoPlayer, type BufferedRange, type PlayerSubtitle } from './video-player';
import {
  closeSession,
  createSession,
  getSession,
  heartbeatSession,
  InsufficientStorageError,
  buildMagnet,
  SessionGoneError,
  sessionCloseBeaconUrl,
  sessionMediaUrl,
  waitForSession,
  type LocalEngineConnection,
  type PlaybackSessionStatus,
  type SessionAudioTrack,
  getLibrary,
  getSkipSegments,
  getSubtitleMatch,
  shipClientLog,
  recordPlayback,
  type SkipSegments,
} from '@/lib/local-engine';
import { supportsHevcRemux } from '@/lib/media-compatibility';
import {
  loadCaptionPrefs,
  preferredSubtitleId,
  saveCaptionPrefs,
  type CaptionColor,
  type CaptionPrefs,
  type CaptionSize,
} from '@/lib/caption-prefs';
import { armWatchSession, releaseWatchKeepalive } from '@/lib/background-playback';
import { historyForEpisode, playbackKey } from '@/lib/library';
import { resolveNextEpisode } from '@/lib/next-episode';
import { loadPlayhead, playheadDeviceId, pickPlayhead, playableResume, RESUME_END_EPSILON, resumeForSource, resumeSeconds, savePlayhead } from '@/lib/playhead';
import { isAutomaticSource, streamKey, type AudioTarget } from '@/lib/stream-select';
import {
  audioTargetFor,
  DUB_LANGUAGE,
  languageName,
  loadAudioChoice,
  loadCaptionsOff,
  offersDub,
  saveAudioChoice,
  saveCaptionsOff,
  sessionAudioLanguage,
  type AudioChoice,
} from '@/lib/audio-choice';
import { ProgressWriter } from '@/lib/progress-writer';
import { forgetSource, loadSource, rememberSource } from '@/lib/source-affinity';
import { prefetchTitle, rankForPlayback } from '@/lib/source-prefetch';
import { fetchStreams } from '@/lib/stream-cache';
import { onCacheClear } from '@/lib/cache-events';
import type { SubtitleReleaseHint } from '@cubo/core';

/** Session starts race sources: how many may run at once, how many are
 *  tried in total, and how long the leader runs alone before a backup joins. */
const RACE_CONCURRENCY = 3;
const RACE_MAX_ATTEMPTS = 5;
const RACE_STAGGER_MS = 5_000;
/** A racer pulling the header at least this fast (MiB/s) is left alone. */
const RACE_HEALTHY_MBPS = 2;
/** A saved position moving back further than this is logged. */
const BACKWARD_JUMP_LOG_SECONDS = 60;
/** How close to the end the next episode gets warmed. */
const NEXT_EPISODE_PREFETCH_SECONDS = 12 * 60;
/** Core writes are coalesced; localStorage is updated on every tick. */
const CORE_PROGRESS_MS = 5_000;
/** Bytes that make the buffering stage feel "full" — playback usually starts well before this. */
const BUFFER_TARGET_BYTES = 16 * 1024 * 1024;
/** Stage ceilings the eased fill creeps toward, so the logo never sits still. */
const STAGE = {
  sources: 0.08,
  core: 0.22,
  opening: 0.4,
  buffering: 0.52,
  bufferingFull: 0.94,
  ready: 1,
};

type Status = 'loading' | 'starting' | 'ready' | 'error';

/** Heartbeat cadence; Core closes sessions it has not heard from in minutes. */
const HEARTBEAT_MS = 5_000;
/** Same-source recoveries (Core restarted, player gave up on a healthy
 *  session) allowed per window before the source counts as failed. */
const RECOVERY_LIMIT = 3;
const RECOVERY_WINDOW_MS = 5 * 60_000;

/** Whether a ready session's file carries `language`. Unknown counts as
 *  yes: older Cores report no tracks, and untagged tracks prove nothing. */
function hasAudio(status: PlaybackSessionStatus, language: string | null): boolean {
  const tracks = status.audioTracks ?? [];
  if (!language || tracks.length === 0) return true;
  const tagged = tracks.filter((track) => track.language);
  if (tagged.some((track) => track.language?.toLowerCase() === language.toLowerCase())) return true;
  return tagged.length < tracks.length;
}

/** How long the "no English audio" notice stays up. */
const AUDIO_NOTICE_MS = 7_000;

function sessionStage(status: PlaybackSessionStatus): number {
  if (status.phase === 'resolving') return STAGE.opening;
  if (status.phase === 'probing') {
    const bytes = status.torrent?.progressBytes ?? 0;
    const ratio = Math.min(1, bytes / BUFFER_TARGET_BYTES);
    return STAGE.buffering + (STAGE.bufferingFull - STAGE.buffering) * ratio;
  }
  return STAGE.ready;
}

export function WatchScreen({
  fullscreenTargetRef,
  mediaType,
  mediaId,
  imdbId,
  title,
  subtitle,
  backHref,
  backdropPath,
  posterPath,
  logoPath,
  originalLanguage,
  season,
  episode,
  seasons,
}: {
  fullscreenTargetRef: RefObject<HTMLDivElement | null>;
  mediaType: MediaType;
  mediaId: number;
  imdbId: string | null;
  title: string;
  subtitle: string | null;
  backHref: string;
  backdropPath: string | null;
  posterPath: string | null;
  logoPath: string | null;
  /** ISO 639-1 language of the title's original audio — dubs rank last. */
  originalLanguage: string | null;
  season?: number;
  episode?: number;
  seasons?: SeasonSummary[];
}) {
  const core = useCore();
  const refreshLibrary = core.refreshLibrary;
  const navigate = useNavigate();

  const [sources, setSources] = useState<Stream[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [needsCore, setNeedsCore] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoIsHls, setVideoIsHls] = useState(false);
  const [videoDurationHint, setVideoDurationHint] = useState<number | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [subtitleTracks, setSubtitleTracks] = useState<PlayerSubtitle[]>([]);
  const [activeSubtitleId, setActiveSubtitleId] = useState<string | null>(null);
  /** Release hint (OpenSubtitles hash etc.) for the source actually playing.
   *  Null until Core computes it; subtitle lookup upgrades itself when it
   *  lands, replacing title-ID-matched tracks with release-exact ones. */
  const [subtitleMatch, setSubtitleMatch] = useState<SubtitleReleaseHint | null>(null);
  /** Intro/credits windows for the file actually playing — per-source, so a
   *  fallback switch clears the previous file's timings. */
  const [skipSegments, setSkipSegments] = useState<SkipSegments | null>(null);
  const [resumeAt, setResumeAt] = useState(0);
  /** What Core has on disk for the current session, for the download bar. */
  const [downloadedRanges, setDownloadedRanges] = useState<BufferedRange[] | null>(null);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  /** Original audio or English dub, for titles not made in English. Null
   *  until decided (the viewer is asked once per title when a dub exists). */
  const [audioChoice, setAudioChoice] = useState<AudioChoice | null>(() => loadAudioChoice(mediaType, mediaId));
  /** What ranking and Core aim for right now; read by in-flight starts. */
  const audioTargetRef = useRef<AudioTarget>(audioTargetFor(audioChoice, originalLanguage));
  /** Resolves the pre-play language question. */
  const [audioPrompt, setAudioPrompt] = useState<((choice: AudioChoice) => void) | null>(null);
  /** Whether any eligible source carries English audio. */
  const [dubAvailable, setDubAvailable] = useState(false);
  /** The playing file's audio tracks and the language actually playing. */
  const [playingAudio, setPlayingAudio] = useState<{ tracks: SessionAudioTrack[]; language: string | null } | null>(null);
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  /** This title's raw Torrentio list, re-ranked when the audio choice changes. */
  const foundRef = useRef<Promise<Stream[]> | null>(null);
  /** False while a dub was asked for but the file only has the original:
   *  that source must not become this episode's remembered pick. */
  const rememberableRef = useRef(true);
  const cacheClearingRef = useRef(false);
  /** The Core playback session currently attached to the player. */
  const sessionRef = useRef<{ connection: LocalEngineConnection; id: string } | null>(null);
  const recoveriesRef = useRef<{ key: string; count: number; since: number } | null>(null);
  /** Startup timeline for the `playback_startup` diagnostic. */
  const startupRef = useRef<{
    t0: number;
    firstStartAt: number | null;
    readyAt: number | null;
    session: PlaybackSessionStatus | null;
    reported: boolean;
  }>({ t0: 0, firstStartAt: null, readyAt: null, session: null, reported: true });

  const releaseSession = useCallback(() => {
    const current = sessionRef.current;
    sessionRef.current = null;
    if (current) closeSession(current.connection, current.id);
  }, []);

  useEffect(() => {
    const stopForCacheClear = (baseUrl: string) => {
      if (playbackConnection.current?.baseUrl !== baseUrl) return;
      cacheClearingRef.current = true;
      playerFlushRef.current?.();
      startAbortRef.current?.abort();
      attemptRef.current += 1;
      setVideoUrl(null);
      setStatus('error');
      setError('Playback stopped to clear storage. Press Retry to start again.');
    };
    return onCacheClear(stopForCacheClear);
  }, []);

  // Caption preferences outlive any single title: the viewer's on/off choice,
  // language, and text size follow them to the next movie or episode.
  const [captionPrefs, setCaptionPrefs] = useState<CaptionPrefs>(() => loadCaptionPrefs());
  const updateCaptionPrefs = useCallback((patch: Partial<CaptionPrefs>) => {
    setCaptionPrefs((current) => {
      const next = { ...current, ...patch };
      saveCaptionPrefs(next);
      return next;
    });
  }, []);

  // Listening to a language other than English means captions by default
  // (English unless the viewer keeps captions in another language).
  const listeningLanguage =
    playingAudio?.language ?? sessionAudioLanguage(audioTargetFor(audioChoice, originalLanguage));
  const foreignAudio = listeningLanguage != null && listeningLanguage.toLowerCase() !== DUB_LANGUAGE;

  const pickSubtitle = useCallback(
    (id: string | null) => {
      setActiveSubtitleId(id);
      if (foreignAudio) saveCaptionsOff(mediaType, mediaId, id === null);
      if (id === null) {
        updateCaptionPrefs({ enabled: false });
        return;
      }
      const track = subtitleTracks.find((entry) => entry.id === id);
      updateCaptionPrefs({ enabled: true, language: track?.language ?? captionPrefs.language });
    },
    [subtitleTracks, captionPrefs.language, updateCaptionPrefs, foreignAudio, mediaType, mediaId],
  );

  const enableCaptions = useCallback(() => {
    // Pick purely by saved language — prefs.enabled is false right now
    // (that's why the viewer is toggling ON), so it must not gate the choice.
    const language = captionPrefs.language?.toLowerCase();
    const match = language
      ? subtitleTracks.find((track) => track.language.toLowerCase() === language)
      : undefined;
    setActiveSubtitleId(match?.id ?? subtitleTracks[0]?.id ?? null);
    updateCaptionPrefs({ enabled: true });
    saveCaptionsOff(mediaType, mediaId, false);
  }, [subtitleTracks, captionPrefs.language, updateCaptionPrefs, mediaType, mediaId]);

  // When a title's tracks arrive, apply whatever the viewer left behind:
  // captions on means this title opens with captions too, same language.
  // Foreign audio turns captions on in English (or the viewer's caption
  // language) unless they switched them off for this title.
  useEffect(() => {
    if (subtitleTracks.length === 0) return;
    setActiveSubtitleId((current) => {
      if (current != null && subtitleTracks.some((track) => track.id === current)) return current;
      if (foreignAudio && !loadCaptionsOff(mediaType, mediaId)) {
        const language = captionPrefs.enabled && captionPrefs.language ? captionPrefs.language : DUB_LANGUAGE;
        return preferredSubtitleId(subtitleTracks, { ...captionPrefs, enabled: true, language });
      }
      return preferredSubtitleId(subtitleTracks, captionPrefs);
    });
    // Only re-apply when a new title's track list lands or the audio changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- captionPrefs intentionally read once per list
  }, [subtitleTracks, foreignAudio]);

  const attemptRef = useRef(0);
  const failedSourcesRef = useRef(new Set<string>());
  const sourceRefreshRef = useRef<Promise<Stream[]> | null>(null);
  /** Cancels the in-flight start sequence (buffer polling included) the
   *  moment a newer attempt begins or the screen unmounts. */
  const startAbortRef = useRef<AbortController | null>(null);
  const targetRef = useRef(STAGE.sources);
  const playbackConnection = useRef<Awaited<ReturnType<typeof core.connect>> | null>(null);
  /** Last position the player reported — lets a source fallback resume in place. */
  const lastPositionRef = useRef(0);
  const activeSourceRef = useRef<Stream | null>(null);
  const activeInfoHashRef = useRef<string | null>(null);
  const lastDurationRef = useRef(0);
  const saveChainRef = useRef(Promise.resolve());
  const progressWriterRef = useRef<ProgressWriter | null>(null);
  const storageBlockedRef = useRef(false);
  if (!progressWriterRef.current) {
    progressWriterRef.current = new ProgressWriter(async (update) => {
      const connection = playbackConnection.current;
      if (!connection) return;
      await recordPlayback(connection, update);
      if (update.sessionStarted) void refreshLibrary();
    });
  }
  const lastCoreSaveRef = useRef(0);
  const unsavedWatchSeconds = useRef(0);
  const playerFlushRef = useRef<(() => void) | null>(null);
  const claimedReadyKey = useRef<string | null>(null);
  const itemKey = playbackKey(mediaType, mediaId, season, episode);

  useEffect(() => {
    armWatchSession();
    return () => releaseWatchKeepalive();
  }, []);

  // The fill eases toward whatever ceiling the current stage set, so it keeps
  // creeping while a stage takes its time and never jumps backwards. The timer
  // stops once playback (or an error) ends the loading sequence — it must not
  // wake the main thread for the whole duration of the movie.
  useEffect(() => {
    if (status === 'ready' || status === 'error') return;
    const timer = window.setInterval(() => {
      setProgress((current) => current + (targetRef.current - current) * 0.14);
    }, 220);
    return () => window.clearInterval(timer);
  }, [status]);

  function setStage(target: number) {
    targetRef.current = target;
  }

  async function start(
    list: Stream[],
    startIndex: number,
    auto: boolean,
    resumeFrom?: number,
    /** Candidates that arrive later (Torrentio results behind a remembered
     *  source); they join the race when they land. */
    more?: Promise<Stream[]>,
  ): Promise<boolean> {
    const attempt = (attemptRef.current += 1);
    const stale = () => attemptRef.current !== attempt || abort.signal.aborted;
    startAbortRef.current?.abort();
    const abort = new AbortController();
    startAbortRef.current = abort;

    storageBlockedRef.current = false;
    releaseSession();
    startupRef.current.firstStartAt ??= performance.now();
    setStatus('starting');
    setError(null);
    setNeedsCore(false);
    setVideoUrl(null);
    setDownloadedRanges(null);
    setVideoDurationHint(null);
    setProgress(0);
    setStage(STAGE.core);

    let connection;
    let resume = resumeFrom ?? 0;
    let savedInfoHash: string | undefined;
    try {
      connection = await core.connect();
      if (stale()) return false;
      if (!connection.sessions) {
        throw new Error('This web build needs an updated Cubo Core. Start the development Core and reconnect.');
      }
      playbackConnection.current = connection;
      if (resumeFrom == null) {
        const local = loadPlayhead(itemKey);
        savedInfoHash = local?.infoHash;
        try {
          const library = await getLibrary(connection);
          if (stale()) return false;
          const previous = library.history.find((item) => item.key === itemKey);
          const chosen = pickPlayhead(
            local,
            previous
              ? {
                  positionSeconds: previous.positionSeconds,
                  durationSeconds: previous.durationSeconds,
                  updatedAt: previous.progressDeviceId === playheadDeviceId()
                    ? previous.progressUpdatedAt ?? previous.lastWatchedAt
                    : previous.lastWatchedAt,
                }
              : null,
          );
          resume = chosen ? playableResume(chosen.positionSeconds, chosen.durationSeconds) : 0;
          lastDurationRef.current = chosen?.durationSeconds ?? 0;
        } catch {
          if (stale()) return false;
          resume = resumeSeconds(local, null);
        }
        if (resume > 0 && !lastDurationRef.current) {
          lastDurationRef.current = local?.durationSeconds ?? 0;
        }
      }
      lastPositionRef.current = resume;
      setResumeAt(resume);
    } catch (reason) {
      if (stale()) return false;
      setNeedsCore(true);
      setStatus('error');
      setError(reason instanceof Error ? reason.message : 'Cubo Core is not connected.');
      return false;
    }
    if (stale()) return false;

    return raceSessions({
      connection,
      list,
      startIndex,
      auto,
      startAtFor: (stream) =>
        resumeFrom != null ? resume : resumeForSource(resume, savedInfoHash, stream.infoHash),
      more,
      abort,
      stale,
    });
  }

  /** Session-backed start. Sources race instead of queueing: the best one
   *  gets a head start, a backup joins every RACE_STAGGER_MS while nothing is
   *  clearly downloading (and at once when a racer fails), and the first to
   *  become ready plays. The rest are closed. A dead source costs seconds,
   *  not Core's resolve timeout. */
  async function raceSessions({
    connection,
    list,
    startIndex,
    auto,
    startAtFor,
    more,
    abort,
    stale,
  }: {
    connection: LocalEngineConnection;
    list: Stream[];
    startIndex: number;
    auto: boolean;
    startAtFor: (stream: Stream) => number;
    more?: Promise<Stream[]>;
    abort: AbortController;
    stale: () => boolean;
  }): Promise<boolean> {
    type Racer = {
      stream: Stream;
      index: number;
      sessionId: string | null;
      status: PlaybackSessionStatus | null;
      done: boolean;
      abort: AbortController;
    };
    let lastError = 'Could not start playback';
    const audioTarget = audioTargetRef.current;
    const audioLanguage = sessionAudioLanguage(audioTarget);
    const dubbing = audioTarget !== null && typeof audioTarget === 'object';
    /** Dub mode: a ready source whose file turned out to have no English
     *  track waits here while the others keep racing, and plays (original
     *  audio, English captions) only if none of them has the dub. */
    let heldBack: { racer: Racer; ready: PlaybackSessionStatus; startAt: number } | null = null;
    const queue: { stream: Stream; index: number }[] = [];
    const queued = new Set<string>();
    const enqueue = (stream: Stream, index: number) => {
      const key = streamKey(stream);
      if (queued.has(key)) return;
      if (auto && failedSourcesRef.current.has(stream.infoHash)) return;
      if (auto && !isAutomaticSource(stream, audioTarget)) {
        lastError = dubbing
          ? 'No source with English audio is available.'
          : 'No suitable original-language source is available.';
        return;
      }
      queued.add(key);
      queue.push({ stream, index });
    };
    const limit = auto ? list.length : startIndex + 1;
    for (let index = startIndex; index < limit; index += 1) enqueue(list[index], index);

    const maxAttempts = auto ? RACE_MAX_ATTEMPTS : 1;
    const racers = new Set<Racer>();
    let launched = 0;
    let lastLaunch = 0;
    let moreDone = !auto || !more;
    let settled = false;

    return new Promise<boolean>((resolve) => {
      const retire = (racer: Racer) => {
        racer.done = true;
        racer.abort.abort();
        racers.delete(racer);
        if (racer.sessionId) closeSession(connection, racer.sessionId);
      };
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        window.clearInterval(timer);
        abort.signal.removeEventListener('abort', onAbort);
        for (const racer of [...racers]) retire(racer);
        if (heldBack) closeSession(connection, heldBack.ready.id);
        resolve(result);
      };
      const play = (racer: Racer, ready: PlaybackSessionStatus, startAt: number) => {
        if (heldBack?.ready.id === ready.id) heldBack = null;
        finish(true);
        // Core may know the title is shorter than the saved progress
        // assumed (the picture ends before the container says). A resume
        // point past the real end means the title was finished.
        const end = ready.durationSeconds ?? 0;
        const resumeAt = end > 0 && startAt >= end - RESUME_END_EPSILON ? 0 : startAt;
        attachSession(connection, racer.stream, racer.index, list.length, auto, resumeAt, ready, abort, stale);
      };
      const onAbort = () => finish(false);
      abort.signal.addEventListener('abort', onAbort);

      const launch = () => {
        if (settled || launched >= maxAttempts) return;
        const next = queue.shift();
        if (!next) return;
        launched += 1;
        lastLaunch = performance.now();
        const racer: Racer = {
          ...next,
          sessionId: null,
          status: null,
          done: false,
          abort: new AbortController(),
        };
        racers.add(racer);
        void run(racer);
      };

      const giveUpOrContinue = () => {
        if (settled || racers.size > 0) return;
        if (queue.length > 0 && launched < maxAttempts) {
          launch();
          return;
        }
        if (!moreDone) return;
        if (heldBack && !stale()) {
          play(heldBack.racer, heldBack.ready, heldBack.startAt);
          return;
        }
        if (!stale()) {
          setStatus('error');
          setError(lastError);
        }
        finish(false);
      };

      const run = async (racer: Racer) => {
        const { stream } = racer;
        const startAt = startAtFor(stream);
        try {
          const created = await createSession(connection, {
            magnet: buildMagnet(stream),
            mediaKey: itemKey,
            title,
            fileIndex: stream.fileIdx ?? null,
            resumeSeconds: startAt,
            hevc: supportsHevcRemux(),
            audioLanguage,
          });
          racer.sessionId = created.id;
          if (racer.done || settled || stale()) {
            closeSession(connection, created.id);
            return;
          }
          const ready = await waitForSession(connection, created.id, {
            signal: racer.abort.signal,
            onStatus: (sessionStatus) => {
              racer.status = sessionStatus;
              if (!stale()) setStage(Math.max(targetRef.current, sessionStage(sessionStatus)));
            },
          });
          if (racer.done || settled || stale()) return;
          racers.delete(racer);
          racer.done = true;
          if (dubbing && auto && !hasAudio(ready, audioLanguage)) {
            shipClientLog(connection, 'info', 'dub_missing', {
              name: stream.name,
              source_title: stream.title,
              held: heldBack == null,
            });
            if (heldBack) {
              closeSession(connection, ready.id);
            } else {
              heldBack = { racer, ready, startAt };
            }
            launch();
            giveUpOrContinue();
            return;
          }
          play(racer, ready, startAt);
        } catch (reason) {
          if (racer.done || settled) return;
          if (stale() || abort.signal.aborted) {
            finish(false);
            return;
          }
          retire(racer);
          lastError = reason instanceof Error ? reason.message : lastError;
          if (reason instanceof InsufficientStorageError) {
            storageBlockedRef.current = true;
            setStatus('error');
            setError(lastError);
            finish(false);
            return;
          }
          shipClientLog(connection, 'warn', 'source_unusable', {
            name: stream.name,
            source_title: stream.title,
            error: lastError,
          });
          failedSourcesRef.current.add(stream.infoHash);
          forgetSource(itemKey, stream.infoHash);
          giveUpOrContinue();
        }
      };

      // Backups join while nobody is visibly downloading. A racer already
      // pulling the file header at a healthy rate is left alone: splitting
      // its bandwidth would slow the likely winner.
      const timer = window.setInterval(() => {
        if (settled || racers.size >= RACE_CONCURRENCY) return;
        if (performance.now() - lastLaunch < RACE_STAGGER_MS) return;
        const healthy = [...racers].some(
          (racer) =>
            racer.status?.phase === 'probing'
            && (racer.status.torrent?.downloadMbps ?? 0) >= RACE_HEALTHY_MBPS,
        );
        if (!healthy) launch();
      }, 500);

      if (!moreDone && more) {
        void more
          .then((extra) => {
            extra.forEach((stream, offset) => enqueue(stream, list.length + offset));
          })
          .catch(() => undefined)
          .finally(() => {
            moreDone = true;
            giveUpOrContinue();
          });
      }

      launch();
      giveUpOrContinue();
    });
  }

  /** Puts a ready session on screen. */
  function attachSession(
    connection: LocalEngineConnection,
    stream: Stream,
    index: number,
    total: number,
    auto: boolean,
    startAt: number,
    ready: PlaybackSessionStatus,
    abort: AbortController,
    stale: () => boolean,
  ) {
    lastPositionRef.current = startAt;
    setResumeAt(startAt);
    activeInfoHashRef.current = stream.infoHash;
    setActiveKey(streamKey(stream));
    setSubtitleMatch(null);
    setSkipSegments(null);
    sessionRef.current = { connection, id: ready.id };

    const fileIndex = ready.fileIndex ?? stream.fileIdx ?? 0;
    const id = ready.torrentId ?? ready.infoHash ?? '';
    activeSourceRef.current = { ...stream, fileIdx: fileIndex };
    const audioTracks = ready.audioTracks ?? [];
    const playing = audioTracks.find((track) => track.index === ready.audioIndex);
    setPlayingAudio(audioTracks.length > 0 ? { tracks: audioTracks, language: playing?.language ?? null } : null);
    const wanted = sessionAudioLanguage(audioTargetRef.current);
    const dubbing = audioTargetRef.current !== null && typeof audioTargetRef.current === 'object';
    const dubMissing = dubbing && !hasAudio(ready, wanted);
    rememberableRef.current = !dubMissing;
    setAudioNotice(
      dubMissing
        ? `No English audio in this release. Playing ${languageName(originalLanguage) ?? 'the original'} with English subtitles.`
        : null,
    );
    shipClientLog(connection, 'info', 'stream_selected', {
      index,
      total,
      auto,
      resume: startAt || undefined,
      direct_play: ready.mode === 'direct',
      name: stream.name,
      source_title: stream.title,
      quality: stream.quality,
      size_bytes: stream.sizeBytes,
      seeders: stream.seeders,
      filename: ready.fileName,
      info_hash: stream.infoHash,
      session: ready.id,
      audio_language: playing?.language ?? undefined,
      audio_tracks: audioTracks.length || undefined,
    });

    // Release-exact subtitles and intro/credits windows load beside
    // playback; neither ever delays it.
    void getSubtitleMatch(connection, id, fileIndex).then((match) => {
      if (!stale()) setSubtitleMatch(match);
    });
    void getSkipSegments(
      connection,
      {
        torrent: String(id),
        file: fileIndex,
        type: mediaType,
        tmdbId: mediaId,
        imdbId,
        season: season ?? undefined,
        episode: episode ?? undefined,
      },
      abort.signal,
    ).then((segments) => {
      if (!stale()) setSkipSegments(segments);
    });

    startupRef.current.readyAt = performance.now();
    startupRef.current.session = ready;
    setStage(STAGE.ready);
    setProgress(1);
    setVideoUrl(sessionMediaUrl(connection, ready));
    setVideoIsHls(ready.mode === 'hls');
    setVideoDurationHint(ready.durationSeconds ?? null);
    setStatus('ready');
  }

  // `start` closes over fresh state every render; a ref keeps the effect below
  // from restarting playback whenever unrelated state changes.
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  });

  useEffect(() => {
    if (!imdbId) {
      setStatus('error');
      setError('No IMDb ID is available for this title, so no sources can be found.');
      return;
    }

    let cancelled = false;
    setStatus('loading');
    setStage(STAGE.sources);
    setError(null);
    startupRef.current = {
      t0: performance.now(),
      firstStartAt: null,
      readyAt: null,
      session: null,
      reported: false,
    };
    recoveriesRef.current = null;

    void (async () => {
      // A successful source can start without waiting for Torrentio again.
      // Refresh alternatives in parallel for real mid-play failures.
      // A list warmed by the next-episode prefetch is used as is (even if a
      // few minutes old) so the race starts at once; it refreshes behind.
      const streamsQuery = streamQueries.streams(mediaType, imdbId, season, episode);
      const warmed = queryClient.getQueryData(streamsQuery.queryKey);
      if (warmed?.length) void queryClient.prefetchQuery(streamsQuery);
      // Otherwise Torrentio, falling back to this title's last saved list
      // when it is slow or down.
      const foundPromise = (warmed?.length
        ? Promise.resolve(warmed)
        : fetchStreams(mediaType, imdbId, season, episode)
      ).catch(() => [] as Stream[]);
      foundRef.current = foundPromise;
      const connection = await core.connect().catch(() => null);
      if (cancelled) return;
      const dubTarget = audioTargetFor('dub', originalLanguage);
      const dubbable = offersDub(originalLanguage);
      const hasDub = (found: Stream[]) =>
        dubbable && rankForPlayback(found, null, connection, { originalLanguage, audio: dubTarget, season, episode }).length > 0;
      void foundPromise.then((found) => {
        if (!cancelled) setDubAvailable(hasDub(found));
      });
      // First visit to a title not made in English: ask original or dub
      // before anything starts, but only when an English source exists.
      let choice = loadAudioChoice(mediaType, mediaId);
      if (choice === null && dubbable) {
        const found = await foundPromise;
        if (cancelled) return;
        if (hasDub(found)) {
          choice = await new Promise<AudioChoice>((resolve) => setAudioPrompt(() => resolve));
          if (cancelled) return;
          setAudioPrompt(null);
          saveAudioChoice(mediaType, mediaId, choice);
        }
      }
      const audio = audioTargetFor(choice, originalLanguage);
      audioTargetRef.current = audio;
      setAudioChoice(choice);
      const savedSource = loadSource(itemKey);
      const rank = (found: Stream[], saved: Stream | null) =>
        rankForPlayback(found, saved, connection, { originalLanguage, audio, season, episode });
      sourceRefreshRef.current = foundPromise.then((found) => rank(found, savedSource));
      try {
        const preferred = rank([], savedSource);
        if (preferred.length > 0 && connection) {
          setSources(preferred);
          // Alternatives join the race as soon as Torrentio answers, so a
          // remembered source that went dead costs seconds, not a timeout.
          const alternatives = foundPromise.then((found) =>
            rank(found.filter((stream) => stream.infoHash !== savedSource?.infoHash), null),
          );
          const started = await startRef.current(preferred, 0, true, undefined, alternatives);
          if (cancelled || storageBlockedRef.current) return;
          if (started) {
            void foundPromise.then((found) => {
              if (!cancelled) setSources(rank(found, savedSource));
            });
            return;
          }
          setStatus('loading');
        }
        const found = await foundPromise;
        if (cancelled) return;
        // A failed remembered torrent must not consume the first retry too.
        const ranked = rank(preferred.length > 0
          ? found.filter((stream) => stream.infoHash !== savedSource?.infoHash)
          : found, null);
        setSources(ranked);
        if (connection) {
          shipClientLog(
            connection,
            'info',
            'sources_ranked',
            {
              media_type: mediaType,
              season: season ?? undefined,
              episode: episode ?? undefined,
              found: found.length,
              kept: ranked.length,
              top: ranked.slice(0, 5).map((stream) => ({
                name: stream.name,
                title: stream.title,
                quality: stream.quality,
                size_bytes: stream.sizeBytes,
                seeders: stream.seeders,
              })),
            },
          );
        }
        if (ranked.length === 0) {
          const seasonEpisodes = mediaType === 'tv' && season != null
            ? await queryClient.fetchQuery(tmdbQueries.season(mediaId, season)).catch(() => undefined)
            : undefined;
          if (cancelled) return;
          const airDate = seasonEpisodes?.find((entry) => entry.episodeNumber === episode)
            ?.airDate;
          setStatus('error');
          setError(
            airDate && isUpcomingAirDate(airDate)
              ? "This episode hasn't come out yet."
              : typeof audio === 'object' && audio !== null
                ? 'No sources with English audio were found for this title.'
                : 'No suitable original-language sources were found for this title.',
          );
          return;
        }
        void startRef.current(ranked, 0, true);
      } catch {
        if (cancelled) return;
        setStatus('error');
        setError('Could not load sources for this title.');
      }
    })();

    return () => {
      cancelled = true;
      setAudioPrompt(null);
      startAbortRef.current?.abort();
      releaseSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- core.connect is stable for a given endpoint
  }, [mediaType, mediaId, imdbId, season, episode]);

  // Tell Core where the viewer is: it paces conversion from this and keeps
  // the session (and its file) alive while the tab is open, even paused.
  useEffect(() => {
    if (status !== 'ready') return;
    const beat = () => {
      const session = sessionRef.current;
      if (!session) return;
      void heartbeatSession(session.connection, session.id, lastPositionRef.current, true)
        .then((ranges) => {
          if (sessionRef.current?.id === session.id) setDownloadedRanges(ranges);
        })
        .catch(() => undefined);
    };
    beat();
    const interval = window.setInterval(beat, HEARTBEAT_MS);
    return () => window.clearInterval(interval);
  }, [status, videoUrl]);

  // Closing the tab ends the session at once instead of after Core's idle
  // timeout (a beacon is the only request that survives unload).
  useEffect(() => {
    const onPageHide = () => {
      const session = sessionRef.current;
      if (!session) return;
      navigator.sendBeacon(sessionCloseBeaconUrl(session.connection, session.id));
      sessionRef.current = null;
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  const reportFirstFrame = useCallback(() => {
    const startup = startupRef.current;
    const connection = playbackConnection.current;
    if (startup.reported || !connection) return;
    startup.reported = true;
    const now = performance.now();
    const since = (at: number | null) => (at == null ? undefined : Math.round(at - startup.t0));
    shipClientLog(connection, 'info', 'playback_startup', {
      total_ms: Math.round(now - startup.t0),
      first_start_ms: since(startup.firstStartAt),
      ready_ms: since(startup.readyAt),
      mode: startup.session?.mode,
      resume: lastPositionRef.current || undefined,
      core: startup.session?.timeline,
    });
  }, []);

  const reportStall = useCallback(
    (stall: { positionSeconds: number; durationMs: number }) => {
      const connection = playbackConnection.current;
      if (!connection) return;
      const base = {
        position: Math.round(stall.positionSeconds),
        duration_ms: Math.round(stall.durationMs),
      };
      const session = sessionRef.current;
      if (!session) {
        shipClientLog(connection, 'warn', 'playback_stall', base);
        return;
      }
      void getSession(session.connection, session.id)
        .then((sessionStatus) => {
          shipClientLog(connection, 'warn', 'playback_stall', {
            ...base,
            mode: sessionStatus.mode,
            peers: sessionStatus.torrent?.peers,
            download_mbps: sessionStatus.torrent?.downloadMbps,
            finished: sessionStatus.torrent?.finished,
            starved_seconds: sessionStatus.remux?.starvedSeconds ?? undefined,
            remux_restarts: sessionStatus.remux?.restarts,
          });
        })
        .catch(() => shipClientLog(connection, 'warn', 'playback_stall', base));
    },
    [],
  );

  // Warm the episode list while the stream resolves so the Episodes drawer
  // opens instantly instead of fetching on click.
  useEffect(() => {
    if (mediaType !== 'tv' || season == null) return;
    void queryClient.prefetchQuery(tmdbQueries.season(mediaId, season));
  }, [mediaType, mediaId, season]);

  // The credits prompt's "Next episode" target: this season's next aired
  // episode, else the premiere of the next season that has aired.
  const currentSeasonEpisodes = useQuery({
    ...tmdbQueries.season(mediaId, season ?? 0),
    enabled: mediaType === 'tv' && season != null,
  });
  const nextEpisode = useMemo(
    () =>
      mediaType === 'tv' && season != null && episode != null
        ? resolveNextEpisode(seasons, currentSeasonEpisodes.data, season, episode)
        : null,
    [mediaType, season, episode, currentSeasonEpisodes.data, seasons],
  );

  // Near the end of an episode, warm the next one so "Next episode" starts
  // at once: its source list, metadata, file header and probe. Checked on a
  // slow timer from the position refs — no re-render per tick.
  useEffect(() => {
    if (status !== 'ready' || !nextEpisode || !imdbId) return;
    const target = nextEpisode;
    const timer = window.setInterval(() => {
      const duration = lastDurationRef.current || videoDurationHint || 0;
      if (duration <= 0) return;
      const remaining = duration - lastPositionRef.current;
      if (remaining > NEXT_EPISODE_PREFETCH_SECONDS) return;
      window.clearInterval(timer);
      void prefetchTitle(playbackConnection.current, {
        mediaType,
        mediaId,
        imdbId,
        title,
        originalLanguage,
        season: target.season,
        episode: target.episode,
      });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [status, nextEpisode, imdbId, mediaType, mediaId, title, originalLanguage, videoDurationHint]);

  useEffect(() => {
    if (!imdbId) return;
    let cancelled = false;
    void queryClient
      .fetchQuery(streamQueries.subtitles(mediaType, imdbId, season, episode, subtitleMatch))
      .then((tracks) => {
        if (cancelled) return;
        const prepared = prepareSubtitles(tracks);
        // Upgrade passes must never leave the viewer worse off: a release
        // match that comes up empty (provider doesn't know this hash) keeps
        // the title-ID tracks already on screen.
        if (subtitleMatch != null && prepared.length === 0) return;
        setSubtitleTracks(prepared);
      })
      .catch(() => {
        // A failed upgrade likewise keeps working tracks; only a failed
        // first lookup means the title genuinely has none.
        if (!cancelled && subtitleMatch == null) setSubtitleTracks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaType, imdbId, season, episode, subtitleMatch]);

  const savePlaybackProgress = useCallback(
    (
      positionSeconds: number,
      durationSeconds: number,
      watchedDeltaSeconds: number,
      sessionStarted: boolean,
      persistNow = false,
    ) => {
      // Unmount / source teardown can report zero. That must not
      // rewind the last trusted playhead we already persisted. A session
      // start at 0 after resume still needs to reach Core — keep the
      // stored playhead instead of dropping the tick.
      if (lastPositionRef.current > 5 && positionSeconds + 1.5 < lastPositionRef.current) {
        if (!sessionStarted && !persistNow) return;
        positionSeconds = lastPositionRef.current;
        durationSeconds = lastDurationRef.current || durationSeconds;
      }
      if (
        lastPositionRef.current - positionSeconds > BACKWARD_JUMP_LOG_SECONDS
        && playbackConnection.current
      ) {
        shipClientLog(playbackConnection.current, 'warn', 'position_jump_back', {
          from: Math.round(lastPositionRef.current),
          to: Math.round(positionSeconds),
          session_started: sessionStarted,
          persist_now: persistNow,
        });
      }
      lastPositionRef.current = positionSeconds;
      lastDurationRef.current = durationSeconds;
      const progressUpdatedAt = savePlayhead(itemKey, positionSeconds, durationSeconds, activeInfoHashRef.current);
      unsavedWatchSeconds.current += Math.max(0, watchedDeltaSeconds);
      const connection = playbackConnection.current;
      if (!connection) return;
      const now = performance.now();
      if (!sessionStarted && !persistNow && now - lastCoreSaveRef.current < CORE_PROGRESS_MS) {
        return;
      }
      lastCoreSaveRef.current = now;
      const update = {
        key: itemKey,
        mediaId,
        mediaType,
        imdbId,
        title,
        subtitle,
        posterPath,
        backdropPath,
        logoPath,
        season: season ?? null,
        episode: episode ?? null,
        positionSeconds,
        durationSeconds,
        progressUpdatedAt,
        progressDeviceId: playheadDeviceId(),
        watchedDeltaSeconds: unsavedWatchSeconds.current,
        sessionStarted,
        watchHref: `/watch/${mediaType}/${mediaId}${season != null && episode != null ? `?season=${season}&episode=${episode}` : ''}`,
        detailHref: backHref,
      };
      unsavedWatchSeconds.current = 0;
      saveChainRef.current = progressWriterRef.current!.enqueue(update);

    },
    [
      itemKey,
      mediaId,
      mediaType,
      imdbId,
      title,
      subtitle,
      posterPath,
      backdropPath,
      logoPath,
      season,
      episode,
      backHref,
      refreshLibrary,
    ],
  );

  const recordSeekIntent = useCallback((targetSeconds: number) => {
    // Record intentional rewinds before the asynchronous seek starts.
    const from = lastPositionRef.current;
    if (from - targetSeconds > BACKWARD_JUMP_LOG_SECONDS && playbackConnection.current) {
      shipClientLog(playbackConnection.current, 'info', 'seek_back', {
        from: Math.round(from),
        to: Math.round(targetSeconds),
      });
    }
    lastPositionRef.current = targetSeconds;
    savePlaybackProgress(targetSeconds, lastDurationRef.current || videoDurationHint || 0, 0, false, true);
  }, [itemKey, savePlaybackProgress, videoDurationHint]);

  const persistLastPlayhead = useCallback(() => {
    playerFlushRef.current?.();
    const duration = lastDurationRef.current || videoDurationHint || 0;
    if (lastPositionRef.current > 0 && duration > 0) {
      savePlaybackProgress(lastPositionRef.current, duration, 0, false, true);
    }
  }, [savePlaybackProgress, videoDurationHint]);

  const persistLastPlayheadRef = useRef(persistLastPlayhead);
  persistLastPlayheadRef.current = persistLastPlayhead;
  const refreshLibraryRef = useRef(refreshLibrary);
  refreshLibraryRef.current = refreshLibrary;

  const finishPlayback = useCallback(async () => {
    persistLastPlayhead();
    const idle = progressWriterRef.current?.whenIdle() ?? saveChainRef.current;
    const saved = idle.then(() => refreshLibrary());
    const giveUp = new Promise<void>((resolve) => {
      window.setTimeout(resolve, 1500);
    });
    await Promise.race([saved, giveUp]);
  }, [persistLastPlayhead, refreshLibrary]);

  // Leaving cancels any start sequence still buffering, then waits for the
  // last playhead to reach Core so Continue Watching is current on arrival.
  useEffect(
    () => () => {
      startAbortRef.current?.abort();
      releaseSession();
      persistLastPlayheadRef.current();
      void (progressWriterRef.current?.whenIdle() ?? Promise.resolve()).then(() => {
        void refreshLibraryRef.current();
      });
    },
    [],
  );

  // Back means "leave the player" — the page the viewer was on before
  // playback, never the previous episode (episode hops don't touch the
  // recorded origin). Falls back to the title's info page when the session
  // started directly on a watch URL.
  const goBack = useCallback(() => {
    void finishPlayback().finally(() => {
      navigate(watchOrigin() ?? backHref);
      resetWindowScroll();
      requestAnimationFrame(resetWindowScroll);
    });
  }, [navigate, backHref, finishPlayback]);

  // The credits prompt's Next episode: flush this episode's progress first,
  // same as any other way of leaving the player.
  const goToNextEpisode = useCallback(() => {
    if (!nextEpisode) return;
    const target = nextEpisode;
    void finishPlayback().finally(() => {
      navigate(`/watch/tv/${mediaId}?season=${target.season}&episode=${target.episode}`);
    });
  }, [nextEpisode, finishPlayback, navigate, mediaId]);

  // The credits window marks the title watched: persist the playhead at the
  // end so a movie leaves Continue Watching and a show's resume resolves to
  // the next episode. Reporting the end is idempotent — the stale-position
  // guard keeps later ticks at the end too.
  const markDoneAtCredits = useCallback(() => {
    const duration = lastDurationRef.current || videoDurationHint || 0;
    if (duration <= 0) return;
    savePlaybackProgress(duration, duration, 0, false, true);
  }, [videoDurationHint, savePlaybackProgress]);

  // Once this episode is actually loaded — even if play() never starts —
  // touch its history row so the title button reads Continue Sx Ex.
  useEffect(() => {
    if (status !== 'ready' || mediaType !== 'tv') return;
    if (season == null || episode == null) return;
    if (claimedReadyKey.current === itemKey) return;
    claimedReadyKey.current = itemKey;
    // start() already reconciled Core and local progress. A second library
    // fetch here can arrive after a seek and overwrite the user's new time.
    savePlaybackProgress(
      lastPositionRef.current,
      lastDurationRef.current || videoDurationHint || 1,
      0,
      false,
      true,
    );
  }, [status, mediaType, season, episode, itemKey, videoDurationHint, savePlaybackProgress]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.fullscreenElement) return;
      goBack();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goBack]);

  // A source died mid-play: quietly move down the ranked list and resume
  // where the viewer was instead of dead-ending on an error.
  function failOver() {
    const failedIndex = sources.findIndex(
      (stream) => streamKey(stream) === activeKey,
    );
    const failed = failedIndex >= 0 ? sources[failedIndex] : null;
    if (failed) {
      failedSourcesRef.current.add(failed.infoHash);
      forgetSource(itemKey, failed.infoHash);
    }
    if (playbackConnection.current) {
      shipClientLog(
        playbackConnection.current,
        'warn',
        'source_failed',
        {
          failed_name: failed?.name,
          failed_title: failed?.title,
          next_index: failedIndex + 1,
          total: sources.length,
          resume_at: lastPositionRef.current || undefined,
        },
      );
    }
    const nextIndex = failedIndex >= 0 ? failedIndex + 1 : 0;
    if (nextIndex < sources.length) {
      void start(sources, nextIndex, true, lastPositionRef.current);
    } else {
      // A remembered source can fail before its alternatives have
      // arrived. Wait for that existing lookup before giving up.
      const attempt = attemptRef.current;
      void (sourceRefreshRef.current ?? Promise.resolve(sources)).then((available) => {
        if (attemptRef.current !== attempt || startAbortRef.current?.signal.aborted) return;
        const alternatives = available.filter((stream) => !failedSourcesRef.current.has(stream.infoHash));
        if (alternatives.length > 0) {
          setSources(alternatives);
          void start(alternatives, 0, true, lastPositionRef.current);
        } else {
          setStatus('error');
          setError('None of the suitable sources could be played in this browser.');
        }
      });
    }
  }

  // A session-backed player gave up. Ask Core before blaming the source:
  // Core restarting (session unknown) or a player-side hiccup on a healthy
  // session resumes the same source in place; only a source Core itself
  // failed moves down the list.
  async function recoverSession(session: { connection: LocalEngineConnection; id: string }) {
    const attempt = attemptRef.current;
    let sessionStatus: PlaybackSessionStatus | null = null;
    let gone = false;
    try {
      sessionStatus = await getSession(session.connection, session.id);
    } catch (reason) {
      gone = reason instanceof SessionGoneError;
    }
    if (attemptRef.current !== attempt || sessionRef.current?.id !== session.id) return;
    shipClientLog(session.connection, 'warn', 'session_error', {
      gone,
      phase: sessionStatus?.phase,
      code: sessionStatus?.error?.code,
      error: sessionStatus?.error?.message,
      starved_seconds: sessionStatus?.remux?.starvedSeconds ?? undefined,
      position: lastPositionRef.current || undefined,
    });
    const healthy = gone || sessionStatus?.phase === 'ready';
    const now = Date.now();
    const key = activeKey ?? '';
    const recoveries =
      recoveriesRef.current?.key === key && now - recoveriesRef.current.since < RECOVERY_WINDOW_MS
        ? recoveriesRef.current
        : { key, count: 0, since: now };
    if (healthy && recoveries.count < RECOVERY_LIMIT) {
      recoveriesRef.current = { ...recoveries, count: recoveries.count + 1 };
      const index = sources.findIndex((stream) => streamKey(stream) === activeKey);
      void start(sources, Math.max(0, index), true, lastPositionRef.current);
      return;
    }
    failOver();
  }

  // The viewer switched between the original and the English dub in the
  // player. The same file restarts on the other track when it has one;
  // otherwise the title's sources are re-ranked for the new language and
  // raced from the current position.
  function switchAudio(next: AudioChoice) {
    if (next === audioChoice) return;
    const target = audioTargetFor(next, originalLanguage);
    const wanted = sessionAudioLanguage(target);
    const position = lastPositionRef.current;
    const active = activeSourceRef.current;
    playerFlushRef.current?.();
    const sameFile = active != null
      && (playingAudio?.tracks ?? []).some((track) => track.language === wanted);
    const commit = () => {
      saveAudioChoice(mediaType, mediaId, next);
      setAudioChoice(next);
      audioTargetRef.current = target;
      if (next === 'dub' && !captionPrefs.enabled) setActiveSubtitleId(null);
      if (playbackConnection.current) {
        shipClientLog(playbackConnection.current, 'info', 'audio_switched', {
          choice: next,
          same_file: sameFile,
          position: Math.round(position) || undefined,
        });
      }
    };
    if (sameFile && active) {
      commit();
      const list = [active, ...sources.filter((stream) => streamKey(stream) !== streamKey(active))];
      setSources(list);
      void start(list, 0, false, position);
      return;
    }
    const attempt = attemptRef.current;
    void (foundRef.current ?? Promise.resolve([] as Stream[])).then((found) => {
      if (attemptRef.current !== attempt) return;
      const ranked = rankForPlayback(found, null, playbackConnection.current, {
        originalLanguage,
        audio: target,
        season,
        episode,
      }).filter((stream) => !failedSourcesRef.current.has(stream.infoHash));
      if (ranked.length === 0) {
        setAudioNotice(next === 'dub'
          ? 'No source with English audio is available for this title.'
          : 'No original-language source is available for this title.');
        return;
      }
      commit();
      setSources(ranked);
      void start(ranked, 0, true, position);
    });
  }

  useEffect(() => {
    if (!audioNotice) return;
    const timer = window.setTimeout(() => setAudioNotice(null), AUDIO_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [audioNotice]);

  const originalName = languageName(originalLanguage) ?? 'Original';
  // The in-player audio menu: offered when the title has a dub on offer
  // and either the file already carries both tracks or a dub source exists.
  const audioOptions = offersDub(originalLanguage)
    && (dubAvailable || (playingAudio?.tracks.some((track) => track.language === DUB_LANGUAGE) ?? false))
    ? [
        { value: 'original', label: `${originalName} (original)` },
        { value: 'dub', label: 'English' },
      ]
    : undefined;

  const backdrop = backdropUrl(backdropPath, 'w780');
  const busy = status === 'loading' || status === 'starting';

  return (
    <div className="fixed inset-0 flex flex-col bg-black">
      {videoUrl && status === 'ready' ? (
        <div className="relative min-h-0 flex-1">
          <VideoPlayer
          fullscreenTargetRef={fullscreenTargetRef}
          topRightControls={mediaType === 'tv' && season != null && episode != null && seasons?.length ? (
            <PlayerEpisodes
              showId={mediaId}
              seasons={seasons}
              season={season}
              episode={episode}
              open={episodesOpen}
              onOpen={() => setEpisodesOpen(true)}
              onClose={() => setEpisodesOpen(false)}
              onNavigate={() => {
                playerFlushRef.current?.();
                setEpisodesOpen(false);
              }}
            />
          ) : null}
          src={videoUrl}
          hls={videoIsHls}
          durationHint={videoDurationHint}
          title={title}
          subtitle={subtitle}
          logoPath={logoPath}
          backHref={backHref}
          onBack={goBack}
          onPickSubtitle={pickSubtitle}
          onEnableCaptions={enableCaptions}
          captionSize={captionPrefs.size}
          onPickCaptionSize={(size: CaptionSize) => updateCaptionPrefs({ size })}
          captionColor={captionPrefs.color}
          onPickCaptionColor={(color: CaptionColor) => updateCaptionPrefs({ color })}
          subtitles={subtitleTracks}
          activeSubtitleId={activeSubtitleId}
          initialTime={resumeAt}
          onPlaybackProgress={savePlaybackProgress}
          downloadedRanges={downloadedRanges}
          onPlaying={() => {
            if (activeSourceRef.current && rememberableRef.current) {
              rememberSource(itemKey, activeSourceRef.current);
            }
            reportFirstFrame();
          }}
          flushRef={playerFlushRef}
          introWindow={skipSegments?.intro ?? null}
          creditsWindow={skipSegments?.credits ?? null}
          onNextEpisode={nextEpisode ? goToNextEpisode : undefined}
          onCreditsReached={markDoneAtCredits}
          sections={skipSegments?.sections}
          onSeekIntent={recordSeekIntent}
          audioOptions={audioOptions}
          activeAudio={audioChoice ?? 'original'}
          onPickAudio={(value) => switchAudio(value === 'dub' ? 'dub' : 'original')}
          onError={() => {
            if (cacheClearingRef.current) return;
            const session = sessionRef.current;
            if (session) {
              void recoverSession(session);
              return;
            }
            failOver();
          }}
          onStall={reportStall}
          />
          {audioNotice ? (
            <div
              role="status"
              className="pointer-events-none absolute left-1/2 top-6 z-30 -translate-x-1/2 rounded-full bg-black/75 px-5 py-2.5 text-center text-sm text-white shadow-2xl backdrop-blur-md"
            >
              {audioNotice}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-6">
          {backdrop ? (
            <img
              src={backdrop}
              alt=""
              className="absolute inset-0 h-full w-full scale-105 object-cover opacity-20 blur-2xl"
            />
          ) : null}
          <div className="absolute inset-0 bg-linear-to-t from-black via-black/60 to-black/80" />

          <button
            type="button"
            onClick={goBack}
            aria-label="Go back"
            className="absolute left-6 top-6 z-50 flex cursor-pointer items-center text-white transition-colors hover:text-white/80 sm:left-10 sm:top-10"
          >
            <IoIosArrowBack size={26} className="drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]" />
          </button>

          <div className="relative flex w-full max-w-xl flex-col items-center text-center">
            <LogoLoader
              title={title}
              progress={busy && !audioPrompt ? Math.min(progress, 1) : null}
              logoPath={logoPath}
            />

            {audioPrompt ? (
              <AudioPrompt
                originalName={originalName}
                onPick={(choice) => audioPrompt(choice)}
              />
            ) : busy ? (
              audioNotice ? <p className="mt-9 text-sm leading-6 text-white/70">{audioNotice}</p> : null
            ) : (
              <>
                <p className="mt-9 leading-7 text-white/80">{error}</p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  {needsCore ? (
                    <button
                      type="button"
                      onClick={core.openSettings}
                      className="flex h-12 cursor-pointer items-center justify-center rounded-full bg-white px-7 font-semibold text-black transition-colors hover:bg-white/85"
                    >
                      Core settings
                    </button>
                  ) : null}
                  {sources.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        cacheClearingRef.current = false;
                        failedSourcesRef.current.clear();
                        void start(sources, 0, true);
                      }}
                      className="flex h-12 cursor-pointer items-center justify-center rounded-full bg-control px-7 font-semibold text-white transition-colors hover:bg-control-hover"
                    >
                      Try again
                    </button>
                  ) : null}
                  <Link
                    href={backHref}
                    className="flex h-12 cursor-pointer items-center justify-center rounded-full bg-control px-7 font-semibold text-white transition-colors hover:bg-control-hover"
                  >
                    Back to details
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

/** First visit to a title not made in English: listen to the original
 *  with English subtitles (the default), or the English dub. */
function AudioPrompt({
  originalName,
  onPick,
}: {
  originalName: string;
  onPick: (choice: AudioChoice) => void;
}) {
  const firstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => firstRef.current?.focus(), []);
  return (
    <div className="mt-9 flex w-full flex-col items-center" role="group" aria-label="Audio language">
      <p className="text-lg font-semibold text-white">How would you like to watch?</p>
      <p className="mt-1.5 text-sm text-white/60">You can change this later in the player settings.</p>
      <div className="mt-6 flex w-full max-w-sm flex-col gap-3">
        <button
          ref={firstRef}
          type="button"
          onClick={() => onPick('original')}
          className="flex cursor-pointer flex-col items-center justify-center rounded-2xl bg-white px-6 py-3.5 text-black transition-colors hover:bg-white/85"
        >
          <span className="font-semibold">{originalName} (original)</span>
          <span className="text-sm text-black/60">With English subtitles</span>
        </button>
        <button
          type="button"
          onClick={() => onPick('dub')}
          className="flex cursor-pointer flex-col items-center justify-center rounded-2xl bg-control px-6 py-3.5 text-white transition-colors hover:bg-control-hover"
        >
          <span className="font-semibold">English</span>
          <span className="text-sm text-white/55">Dubbed audio</span>
        </button>
      </div>
    </div>
  );
}

function PlayerEpisodes({
  showId,
  seasons,
  season,
  episode,
  open,
  onOpen,
  onClose,
  onNavigate,
}: {
  showId: number;
  seasons: SeasonSummary[];
  season: number;
  episode: number;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onNavigate: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const wasOpenRef = useRef(false);
  const [selectedSeason, setSelectedSeason] = useState(season);
  const { library } = useCore();
  // Ungated: the current season is usually warm from the mount prefetch, and
  // switching seasons in the drawer fetches that season on demand.
  const episodes = useQuery(tmdbQueries.season(showId, selectedSeason));

  useEffect(() => setSelectedSeason(season), [season]);

  useEffect(() => {
    const dialog = drawerRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open && wasOpenRef.current) triggerRef.current?.focus();
    wasOpenRef.current = open;
  }, [open]);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        aria-label="Episodes"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onOpen}
        className="pointer-events-auto absolute right-4 top-4 z-20 flex h-10 cursor-pointer w-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-md transition-colors hover:bg-black/80 sm:right-6 sm:top-6"
      >
        <IoList size={21} />
      </button>
      {createPortal(
        <dialog
          ref={drawerRef}
          data-player-episodes
          onCancel={(event) => { event.preventDefault(); onClose(); }}
          onClick={(event) => {
            if (event.target === event.currentTarget && event.clientX < event.currentTarget.getBoundingClientRect().left) onClose();
          }}
          className="fixed inset-y-0 left-auto right-0 m-0 h-dvh cursor-auto max-h-none w-full max-w-md overflow-hidden border-0 bg-panel p-0 text-white shadow-[-24px_0_80px_rgba(0,0,0,0.55)] backdrop:bg-black/40"
          role="dialog"
          aria-label="Episodes"
        >
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-5">
            <div className="flex min-w-0 items-center gap-3">
              <h2 className="text-lg font-semibold">Episodes</h2>
              {seasons.length > 1 ? (
                <Dropdown
                  value={selectedSeason}
                  options={seasons.map((entry) => ({
                    value: entry.seasonNumber,
                    label: entry.name || `Season ${entry.seasonNumber}`,
                  }))}
                  onChange={setSelectedSeason}
                  ariaLabel="Season"
                />
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Close episodes"
              onClick={onClose}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-control hover:bg-control-hover"
            >
              <IoClose size={22} />
            </button>
          </div>
          <div className="min-h-0 h-[calc(100%-81px)] overflow-y-auto p-3">
            {episodes.error ? <p className="px-3 py-4 text-faint">Could not load that season.</p> : null}
            {episodes.isPending ? <p className="px-3 py-4 text-faint">Loading episodes…</p> : null}
            <ul className="m-0 list-none space-y-2 p-0">
              {(episodes.data ?? []).map((entry: Episode) => (
                <EpisodeRow
                  key={entry.id}
                  showId={showId}
                  episode={entry}
                  compact
                  active={entry.seasonNumber === season && entry.episodeNumber === episode}
                  watched={historyForEpisode(
                    library?.history,
                    showId,
                    entry.seasonNumber,
                    entry.episodeNumber,
                  )}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}

function prepareSubtitles(tracks: SubtitleTrack[]): PlayerSubtitle[] {
  const seen = new Set<string>();
  const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
  const prepared: PlayerSubtitle[] = [];

  for (const track of tracks) {
    if (seen.has(track.language)) continue;
    seen.add(track.language);
    let label: string | undefined;
    try {
      label = displayNames.of(track.language);
    } catch {
      // Skip language codes that cannot be presented clearly to viewers.
    }
    if (!label || label.toLowerCase() === track.language.toLowerCase()) continue;
    prepared.push({
      id: track.id,
      src: apiUrl(`/api/subtitle-file?url=${encodeURIComponent(track.url)}&enc=2`),
      language: track.language,
      label,
    });
    if (prepared.length >= 18) break;
  }

  return prepared;
}
