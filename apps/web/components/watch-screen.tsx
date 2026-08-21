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
  type Stream,
  type SubtitleTrack,
} from '@cubo/core';
import { IoIosArrowBack } from 'react-icons/io';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Link } from '@/components/link';
import { apiUrl } from '@/lib/api';
import { isUpcomingAirDate } from '@/lib/air-date';
import { queryClient, streamQueries, tmdbQueries } from '@/lib/queries';
import { useCore } from './core-provider';
import { LogoLoader } from './logo-loader';
import { resetWindowScroll } from './scroll-to-top';
import { VideoPlayer, type PlayerSubtitle } from './video-player';
import {
  addMagnet,
  buildMagnet,
  getLibrary,
  getSubtitleMatch,
  shipClientLog,
  isDesktopRuntime,
  largestFileIndex,
  recordPlayback,
  startRemux,
  streamUrl,
  waitUntilLive,
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
import { playbackKey } from '@/lib/library';
import { rankStreams, streamKey } from '@/lib/stream-select';
import type { SubtitleReleaseHint } from '@cubo/core';

const AUTO_ATTEMPTS = 3;
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
  const [resumeAt, setResumeAt] = useState(0);

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
  /** Cancels the in-flight start sequence (buffer polling included) the
   *  moment a newer attempt begins or the screen unmounts. */
  const startAbortRef = useRef<AbortController | null>(null);
  const targetRef = useRef(STAGE.sources);
  const playbackConnection = useRef<Awaited<ReturnType<typeof core.connect>> | null>(null);
  /** Last position the player reported — lets a source fallback resume in place. */
  const lastPositionRef = useRef(0);
  /** Torrent behind the current remux, so seeks can restart its converter. */
  const remuxContext = useRef<{
    connection: Awaited<ReturnType<typeof core.connect>>;
    id: number | string;
    fileIndex: number;
  } | null>(null);
  const seekAttemptRef = useRef(0);
  const itemKey = playbackKey(mediaType, mediaId, season, episode);

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
  ) {
    const attempt = (attemptRef.current += 1);
    const stale = () => attemptRef.current !== attempt;
    startAbortRef.current?.abort();
    const abort = new AbortController();
    startAbortRef.current = abort;

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
    try {
      connection = await core.connect();
      playbackConnection.current = connection;
      if (resumeFrom == null) {
        try {
          const library = await getLibrary(connection);
          const previous = library.history.find((item) => item.key === itemKey);
          resume = previous && previous.progress < 0.9 ? previous.positionSeconds : 0;
        } catch {
          resume = 0;
        }
      }
      setResumeAt(resume);
    } catch (reason) {
      if (stale()) return;
      setNeedsCore(true);
      setStatus('error');
      setError(reason instanceof Error ? reason.message : 'Cubo Core is not connected.');
      return;
    }
    if (stale()) return;

    const limit = auto ? Math.min(list.length, startIndex + AUTO_ATTEMPTS) : startIndex + 1;
    let lastError = 'Could not start playback';

    for (let index = startIndex; index < limit; index += 1) {
      const stream = list[index];
      setActiveKey(streamKey(stream));
      setSubtitleMatch(null);

      try {
        setStage(STAGE.opening);
        const added = await addMagnet(connection, buildMagnet(stream), {
          mediaKey: itemKey,
          title,
        });
        if (stale()) return;

        const fileIndex = stream.fileIdx ?? largestFileIndex(added.files);
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

        // Compute the release hash in the background — it may pull the file's
        // tail from peers and take a while. When it lands, the subtitle
        // effect refetches with an exact-release match.
        void getSubtitleMatch(connection, id, fileIndex).then((match) => {
          if (!stale()) setSubtitleMatch(match);
        });

        shipClientLog(
          connection,
          'info',
          'stream_selected',
          {
            index,
            total: list.length,
            auto,
            resume: resume || undefined,
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
            if (stale()) return;
            setStage(bufferingTarget(stats));
          },
        });
        if (stale()) return;

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
          const remux = await startRemux(connection, id, fileIndex, resume);
          url = remux.url;
          durationHint = remux.durationSeconds;
          usesHls = true;
          timeOffset = remux.startSeconds;
          localJump = resume - timeOffset;
          if (localJump < 0.25) localJump = null;
          remuxContext.current = { connection, id, fileIndex };
          if (stale()) return;
        }

        setStage(STAGE.ready);
        setProgress(1);
        // Let the logo finish filling before the picture takes over.
        window.setTimeout(() => {
          if (stale()) return;
          setVideoUrl(url);
          setVideoIsHls(usesHls);
          setVideoDurationHint(durationHint);
          setVideoTimeOffset(timeOffset);
          setVideoStartLocal(localJump);
          setStatus('ready');
        }, 480);
        return;
      } catch (reason) {
        if (stale() || abort.signal.aborted) return;
        lastError = reason instanceof Error ? reason.message : lastError;
      }
    }

    setStatus('error');
    setError(lastError);
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
      // The Core's transcode capability decides which sources are playable,
      // so resolve the connection before ranking. A failed connection still
      // ranks (direct-play only) and surfaces the Core error via start().
      const connection = await core.connect().catch(() => null);
      try {
        const [found, seasonEpisodes] = await Promise.all([
          queryClient.fetchQuery(
            streamQueries.streams(mediaType, imdbId, season, episode),
          ),
          mediaType === 'tv' && season != null
            ? queryClient.fetchQuery(tmdbQueries.season(mediaId, season))
            : Promise.resolve(undefined),
        ]);
        if (cancelled) return;
        const ranked = rankStreams(
          found,
          { transcode: connection?.transcode ?? false, hevc: supportsHevcRemux() },
          originalLanguage,
        );
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
          const airDate = seasonEpisodes?.find((entry) => entry.episodeNumber === episode)
            ?.airDate;
          setStatus('error');
          setError(
            airDate && isUpcomingAirDate(airDate)
              ? "This episode hasn't come out yet."
              : 'No browser-compatible sources were found for this title.',
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- core.connect is stable for a given endpoint
  }, [mediaType, mediaId, imdbId, season, episode]);

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
    ) => {
      lastPositionRef.current = positionSeconds;
      const connection = playbackConnection.current;
      if (!connection) return;
      void recordPlayback(connection, {
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
        watchedDeltaSeconds,
        sessionStarted,
        watchHref: `/watch/${mediaType}/${mediaId}${season != null && episode != null ? `?season=${season}&episode=${episode}` : ''}`,
        detailHref: backHref,
      })
        .then(() => {
          // Refreshing on every periodic report refetched the whole library
          // every 10s during playback; once per session start is enough while
          // playing — the unmount refresh below picks up the final position.
          if (sessionStarted) void refreshLibrary();
        })
        .catch(() => undefined);
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

  // A seek outside the converted window restarts ffmpeg at the target and
  // swaps in the new playlist. Last request wins if the viewer keeps seeking.
  const requestRemuxSeek = useCallback(async (targetSeconds: number) => {
    const context = remuxContext.current;
    if (!context) return;
    const attempt = (seekAttemptRef.current += 1);
    setSeekConverting(true);
    try {
      const remux = await startRemux(
        context.connection,
        context.id,
        context.fileIndex,
        targetSeconds,
      );
      if (seekAttemptRef.current !== attempt) return;
      lastPositionRef.current = targetSeconds;
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
    } catch {
      // The converter could not restart there; playback continues in place.
    } finally {
      if (seekAttemptRef.current === attempt) setSeekConverting(false);
    }
  }, []);

  // Refresh Continue Watching once the viewer leaves the player. The small
  // delay lets the player's final progress flush land first. Leaving also
  // cancels any start sequence still buffering — it would otherwise keep
  // polling Core long after the viewer has moved on.
  const refreshLibraryRef = useRef(refreshLibrary);
  refreshLibraryRef.current = refreshLibrary;
  useEffect(
    () => () => {
      startAbortRef.current?.abort();
      window.setTimeout(() => void refreshLibraryRef.current(), 400);
    },
    [],
  );

  // Back means BACK — the page the viewer came from, not always the info
  // page (e.g. Home → Watch should land on Home). Falls back to `backHref`.
  const goBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate(backHref);
    // History POP otherwise restores the catalog/title scroll we left from.
    resetWindowScroll();
    requestAnimationFrame(resetWindowScroll);
  }, [navigate, backHref]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.fullscreenElement) return;
      void (async () => {
        // The desktop app fullscreens the native window, which the DOM
        // fullscreen API can't see — Escape should exit that, not the player.
        if (isDesktopRuntime()) {
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const appWindow = getCurrentWindow();
            if (await appWindow.isFullscreen()) {
              await appWindow.setFullscreen(false);
              return;
            }
          } catch {
            // Fall through to navigation.
          }
        }
        goBack();
      })();
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
          onSeekOutside={(target) => void requestRemuxSeek(target)}
          onError={() => {
            // A source died mid-play: quietly move down the ranked list and
            // resume where the viewer was instead of dead-ending on an error.
            const failedIndex = sources.findIndex(
              (stream) => streamKey(stream) === activeKey,
            );
            const failed = failedIndex >= 0 ? sources[failedIndex] : null;
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
              setStatus('error');
              setError('None of the available sources could be played in this browser.');
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
            className="desktop-back-offset absolute left-6 top-6 z-50 flex cursor-pointer items-center text-white transition-colors hover:text-white/80 sm:left-10 sm:top-10"
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
                      onClick={() => void start(sources, 0, true)}
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
      src: apiUrl(`/api/subtitle-file?url=${encodeURIComponent(track.url)}`),
      language: track.language,
      label,
    });
    if (prepared.length >= 18) break;
  }

  return prepared;
}
