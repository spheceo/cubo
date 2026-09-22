/**
 * Orchestrates a playback session: source ranking, torrent add + buffering,
 * direct-play vs Core remux decision, resume, mid-play source fallback, and
 * seek-restarts of the converter. Part of the verified-working playback
 * pipeline (see AGENTS.md); the ordering of these steps and the absolute-time
 * offset model are deliberate — change with care.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { VideoPlayer, type PlayerSubtitle } from './video-player';
import {
  addMagnet,
  InsufficientStorageError,
  buildMagnet,
  getLibrary,
  getSkipSegments,
  getSubtitleMatch,
  shipClientLog,
  largestFileIndex,
  recordPlayback,
  startRemux,
  streamUrl,
  waitUntilLive,
  type SkipSegments,
  type TorrentProgress,
} from '@/lib/local-engine';
import {
  isBrowserPlayableFilename,
  isRemuxableFilename,
  supportsHevcRemux,
} from '@/lib/media-compatibility';
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
import { loadPlayhead, playheadDeviceId, pickPlayhead, playableResume, resumeForSource, resumeSeconds, savePlayhead } from '@/lib/playhead';
import { isAutomaticSource, rankStreams, streamKey } from '@/lib/stream-select';
import { ProgressWriter } from '@/lib/progress-writer';
import { forgetSource, loadSource, preferSource, rememberSource } from '@/lib/source-affinity';
import { onCacheClear } from '@/lib/cache-events';
import type { SubtitleReleaseHint } from '@cubo/core';

const AUTO_ATTEMPTS = 3;
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

export function WatchScreen({
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
  /** Where the current remux playlist begins within the source (seek restart). */
  const [videoTimeOffset, setVideoTimeOffset] = useState(0);
  /** Playlist-local jump that makes up the gap between the keyframe ffmpeg
   *  landed on and the exact position the viewer requested. */
  const [videoStartLocal, setVideoStartLocal] = useState<number | null>(null);
  const [seekConverting, setSeekConverting] = useState(false);
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
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const cacheClearingRef = useRef(false);

  useEffect(() => {
    const stopForCacheClear = (baseUrl: string) => {
      if (playbackConnection.current?.baseUrl !== baseUrl) return;
      cacheClearingRef.current = true;
      playerFlushRef.current?.();
      startAbortRef.current?.abort();
      attemptRef.current += 1;
      setVideoUrl(null);
      setSeekConverting(false);
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

  const pickSubtitle = useCallback(
    (id: string | null) => {
      setActiveSubtitleId(id);
      if (id === null) {
        updateCaptionPrefs({ enabled: false });
        return;
      }
      const track = subtitleTracks.find((entry) => entry.id === id);
      updateCaptionPrefs({ enabled: true, language: track?.language ?? captionPrefs.language });
    },
    [subtitleTracks, captionPrefs.language, updateCaptionPrefs],
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
  }, [subtitleTracks, captionPrefs.language, updateCaptionPrefs]);

  // When a title's tracks arrive, apply whatever the viewer left behind:
  // captions on means this title opens with captions too, same language.
  useEffect(() => {
    if (subtitleTracks.length === 0) return;
    setActiveSubtitleId((current) => {
      if (current != null && subtitleTracks.some((track) => track.id === current)) return current;
      return preferredSubtitleId(subtitleTracks, captionPrefs);
    });
    // Only re-apply when a new title's track list lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- captionPrefs intentionally read once per list
  }, [subtitleTracks]);

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
  /** Torrent behind the current remux, so seeks can restart its converter. */
  const remuxContext = useRef<{
    connection: Awaited<ReturnType<typeof core.connect>>;
    id: number | string;
    fileIndex: number;
  } | null>(null);
  const seekAttemptRef = useRef(0);
  /** Incremented on every remux kickoff so leftover hls.js polls of the
   *  previous playlist URL cannot restart ffmpeg at the old offset. */
  const remuxGenRef = useRef(0);
  /** True from the moment a remux seek is requested until the old player
   *  has unmounted — killing ffmpeg looks like a fatal HLS error. */
  const seekingRef = useRef(false);
  /** Absolute target of an in-flight remux seek; blocks stale progress
   *  flushes from overwriting `lastPositionRef` with the pre-seek time. */
  const seekTargetRef = useRef<number | null>(null);
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
  ): Promise<boolean> {
    const attempt = (attemptRef.current += 1);
    const stale = () => attemptRef.current !== attempt || abort.signal.aborted;
    startAbortRef.current?.abort();
    const abort = new AbortController();
    startAbortRef.current = abort;

    storageBlockedRef.current = false;
    setStatus('starting');
    setError(null);
    setNeedsCore(false);
    setVideoUrl(null);
    setVideoDurationHint(null);
    setVideoTimeOffset(0);
    setVideoStartLocal(null);
    setSeekConverting(false);
    remuxContext.current = null;
    setProgress(0);
    setStage(STAGE.core);

    let connection;
    let resume = resumeFrom ?? 0;
    let savedInfoHash: string | undefined;
    try {
      connection = await core.connect();
      if (stale()) return false;
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

    const limit = auto ? list.length : startIndex + 1;
    let lastError = 'Could not start playback';
    let attempts = 0;

    for (let index = startIndex; index < limit; index += 1) {
      const stream = list[index];
      if (auto && failedSourcesRef.current.has(stream.infoHash)) continue;
      if (auto && !isAutomaticSource(stream, originalLanguage)) {
        lastError = 'No suitable original-language source is available.';
        continue;
      }
      if (auto && attempts >= AUTO_ATTEMPTS) break;
      attempts += 1;

      const startAt =
        resumeFrom != null
          ? resume
          : resumeForSource(resume, savedInfoHash, stream.infoHash);
      lastPositionRef.current = startAt;
      setResumeAt(startAt);
      activeInfoHashRef.current = stream.infoHash;
      activeSourceRef.current = stream;
      setActiveKey(streamKey(stream));
      setSubtitleMatch(null);
      setSkipSegments(null);

      try {
        setStage(STAGE.opening);
        const added = await addMagnet(connection, buildMagnet(stream), {
          mediaKey: itemKey,
          title,
          fileIndex: stream.fileIdx,
        });
        if (stale()) return false;

        const fileIndex = stream.fileIdx ?? largestFileIndex(added.files);
        activeSourceRef.current = { ...stream, fileIdx: fileIndex };
        const filename = added.files[fileIndex]?.name ?? stream.filename ?? '';
        const hint = `${stream.name} ${stream.title}`;
        const direct = isBrowserPlayableFilename(filename, hint);
        if (
          !direct &&
          !(connection.transcode && isRemuxableFilename(filename, hint, supportsHevcRemux()))
        ) {
          throw new Error('This source uses video or audio the browser cannot play.');
        }

        const id = added.id ?? added.infoHash;
        if (id === null || id === '') throw new Error('Cubo Core did not return a torrent ID');


        shipClientLog(
          connection,
          'info',
          'stream_selected',
          {
            index,
            total: list.length,
            auto,
            resume: startAt || undefined,
            direct_play: direct,
            name: stream.name,
            source_title: stream.title,
            quality: stream.quality,
            size_bytes: stream.sizeBytes,
            seeders: stream.seeders,
            filename: filename || undefined,
            info_hash: stream.infoHash,
          },
        );

        setStage(STAGE.buffering);
        await waitUntilLive(connection, id, {
          signal: abort.signal,
          onProgress: (stats) => {
            if (stale()) return false;
            setStage(bufferingTarget(stats));
          },
        });
        if (stale()) return false;

        // rqbit is now live; hashing during checksum validation returns 500.
        // Compute the release hash in the background — it may pull the file's
        // tail from peers and take a while. When it lands, the subtitle
        // effect refetches with an exact-release match.
        void getSubtitleMatch(connection, id, fileIndex).then((match) => {
          if (!stale()) setSubtitleMatch(match);
        });

        // Intro/credits windows: named chapters first inside Core, crowd
        // APIs after. Fires in parallel with the stream warm-up — playback
        // never waits on it, and a missing answer just means no skip UI.
        const segmentQuery = {
          torrent: String(id),
          file: fileIndex,
          type: mediaType,
          tmdbId: mediaId,
          imdbId,
          season: season ?? undefined,
          episode: episode ?? undefined,
        };
        void getSkipSegments(connection, segmentQuery, abort.signal).then(
          (segments) => {
            if (stale()) return;
            setSkipSegments(segments);
            // A cold file can answer remote-only while its ffprobe is still
            // in flight — retry once so exact chapter timings get their turn.
            if (!segments?.sections?.some((s) => s.source === 'chapters')) {
              const retry = window.setTimeout(() => {
                void getSkipSegments(connection, segmentQuery, abort.signal).then(
                  (next) => {
                    if (!stale() && next) setSkipSegments(next);
                  },
                );
              }, 12_000);
              abort.signal.addEventListener('abort', () => window.clearTimeout(retry), {
                once: true,
              });
            }
          },
        );


        let url: string;
        let usesHls = false;
        let durationHint: number | null = null;
        let timeOffset = 0;
        let localJump: number | null = null;
        if (direct) {
          url = streamUrl(connection, id, fileIndex);
        } else {
          // Core remuxes the file into browser-friendly HLS; the call returns
          // once the first segments are playable. The playlist actually
          // begins where ffmpeg's input seek landed (the keyframe at/before
          // `resume`) — that measured offset is what keeps absolute times
          // truthful; the local jump closes any gap up to the exact spot.
          setStage(STAGE.buffering);
          const remux = await startRemux(
            connection,
            id,
            fileIndex,
            startAt,
            ++remuxGenRef.current,
          );
          url = remux.url;
          durationHint = remux.durationSeconds;
          usesHls = true;
          timeOffset = remux.startSeconds;
          localJump = startAt - timeOffset;
          if (localJump < 0.25) localJump = null;
          if (stale()) return false;
          remuxContext.current = { connection, id, fileIndex };
        }

        setStage(STAGE.ready);
        setProgress(1);
        const reveal = () => {
          if (stale()) return false;
          setVideoUrl(url);
          setVideoIsHls(usesHls);
          setVideoDurationHint(durationHint);
          setVideoTimeOffset(timeOffset);
          setVideoStartLocal(localJump);
          setStatus('ready');
        };
        // Attach as soon as the source is ready; loader animation must not
        // delay the first media request.
        reveal();
        return true;
      } catch (reason) {
        if (stale() || abort.signal.aborted) return false;
        lastError = reason instanceof Error ? reason.message : lastError;
        if (reason instanceof InsufficientStorageError) {
          storageBlockedRef.current = true;
          break;
        }
        failedSourcesRef.current.add(stream.infoHash);
        forgetSource(itemKey, stream.infoHash);
      }
    }

    setStatus('error');
    setError(lastError);
    return false;
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

    void (async () => {
      // A successful source can start without waiting for Torrentio again.
      // Refresh alternatives in parallel for real mid-play failures.
      const foundPromise = queryClient.fetchQuery(
        streamQueries.streams(mediaType, imdbId, season, episode),
      ).catch(() => [] as Stream[]);
      const connection = await core.connect().catch(() => null);
      if (cancelled) return;
      const savedSource = loadSource(itemKey);
      const rank = (found: Stream[], saved: Stream | null) => preferSource(rankStreams(
        saved ? [saved, ...found.filter((stream) =>
          stream.infoHash !== saved.infoHash || (stream.fileIdx != null && stream.fileIdx !== saved.fileIdx),
        )] : found,
        { transcode: connection?.transcode ?? false, hevc: supportsHevcRemux() },
        originalLanguage,
        season != null && episode != null ? { season, episode } : null,
      ).filter((stream) => isAutomaticSource(stream, originalLanguage)), saved);
      sourceRefreshRef.current = foundPromise.then((found) => rank(found, savedSource));
      try {
        const preferred = rank([], savedSource);
        if (preferred.length > 0 && connection) {
          setSources(preferred);
          const started = await startRef.current(preferred, 0, true);
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
      startAbortRef.current?.abort();
      seekAttemptRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- core.connect is stable for a given endpoint
  }, [mediaType, mediaId, imdbId, season, episode]);

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
      // A remux seek's old player still reports time (and flushes on
      // src swap); that must not overwrite the seek target.
      if (seekingRef.current || seekTargetRef.current != null) return;
      // Unmount / src teardown often reports timeOffset+0. That must not
      // rewind the last trusted playhead we already persisted. A session
      // start at 0 after resume still needs to reach Core — keep the
      // stored playhead instead of dropping the tick.
      if (lastPositionRef.current > 5 && positionSeconds + 1.5 < lastPositionRef.current) {
        if (!sessionStarted && !persistNow) return;
        positionSeconds = lastPositionRef.current;
        durationSeconds = lastDurationRef.current || durationSeconds;
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
    lastPositionRef.current = targetSeconds;
    if (seekingRef.current || seekTargetRef.current != null) {
      savePlayhead(itemKey, targetSeconds, lastDurationRef.current || videoDurationHint || 0, activeInfoHashRef.current);
    } else {
      savePlaybackProgress(targetSeconds, lastDurationRef.current || videoDurationHint || 0, 0, false, true);
    }
  }, [itemKey, savePlaybackProgress, videoDurationHint]);

  // A seek outside the converted window restarts ffmpeg at the target and
  // swaps in the new playlist. Last request wins if the viewer keeps seeking.
  const requestRemuxSeek = useCallback(async (targetSeconds: number) => {
    const context = remuxContext.current;
    if (!context) return;
    const attempt = (seekAttemptRef.current += 1);
    lastPositionRef.current = targetSeconds;
    seekTargetRef.current = targetSeconds;
    seekingRef.current = true;
    setSeekConverting(true);
    try {
      const remux = await startRemux(
        context.connection,
        context.id,
        context.fileIndex,
        targetSeconds,
        ++remuxGenRef.current,
      );
      if (seekAttemptRef.current !== attempt) return;
      // The restarted converter begins at its own landing keyframe — adopt
      // it as the new absolute origin, then close the gap locally.
      setVideoTimeOffset(remux.startSeconds);
      const gap = targetSeconds - remux.startSeconds;
      setVideoStartLocal(gap >= 0.25 ? gap : null);
      setVideoUrl(remux.url);
      shipClientLog(
        context.connection,
        'info',
        'remux_seek',
        {
          requested: targetSeconds,
          landed_at: remux.startSeconds,
          local_jump: gap >= 0.25 ? gap : 0,
        },
      );
    } catch (reason) {
      // The converter could not restart there; playback continues in place.
      shipClientLog(
        context.connection,
        'warn',
        'remux_seek_failed',
        {
          requested: targetSeconds,
          error: reason instanceof Error ? reason.message : undefined,
        },
      );
    } finally {
      if (seekAttemptRef.current === attempt) setSeekConverting(false);
    }
  }, []);

  // Drop the seek guards only after React has unmounted the old player —
  // its HLS fatal error and progress flush run in that commit's cleanups.
  useEffect(() => {
    if (seekConverting) return;
    seekingRef.current = false;
    seekTargetRef.current = null;
  }, [seekConverting]);

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

  const backdrop = backdropUrl(backdropPath, 'w780');
  const busy = status === 'loading' || status === 'starting';

  return (
    <div className="fixed inset-0 flex flex-col bg-black">
      {videoUrl && status === 'ready' ? (
        <div className="relative min-h-0 flex-1">
          <VideoPlayer
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
          timeOffset={videoTimeOffset}
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
          initialTime={videoIsHls ? 0 : resumeAt}
          startTimeLocal={videoIsHls ? videoStartLocal : null}
          onPlaybackProgress={savePlaybackProgress}
          onPlaying={() => {
            if (activeSourceRef.current) rememberSource(itemKey, activeSourceRef.current);
          }}
          flushRef={playerFlushRef}
          introWindow={skipSegments?.intro ?? null}
          creditsWindow={skipSegments?.credits ?? null}
          onNextEpisode={nextEpisode ? goToNextEpisode : undefined}
          onCreditsReached={markDoneAtCredits}
          sections={skipSegments?.sections}
          onSeekIntent={recordSeekIntent}
          onSeekOutside={(target) => void requestRemuxSeek(target)}
          onError={() => {
            if (cacheClearingRef.current) return;
            // Restarting ffmpeg for a seek kills the current playlist;
            // that looks identical to a dead source and must not fall
            // through to the next torrent at the old resume position.
            if (seekingRef.current || seekTargetRef.current != null) return;
            // A source died mid-play: quietly move down the ranked list and
            // resume where the viewer was instead of dead-ending on an error.
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
          }}
          />

          {seekConverting ? (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/60">
              <LogoLoader title={title} progress={null} size="sm" logoPath={logoPath} />
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
              progress={busy ? Math.min(progress, 1) : null}
              logoPath={logoPath}
            />

            {busy ? null : (
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

function bufferingTarget(stats: TorrentProgress): number {
  const ratio = Math.min(1, stats.downloadedBytes / BUFFER_TARGET_BYTES);
  return STAGE.buffering + (STAGE.bufferingFull - STAGE.buffering) * ratio;
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
