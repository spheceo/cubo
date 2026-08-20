import {
  backdropUrl,
  type MediaType,
  type Stream,
  type SubtitleTrack,
} from '@cubo/core';
import { CaretLeft } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Link } from '@/components/link';
import { apiUrl, catalog } from '@/lib/api';
import { useCore } from './core-provider';
import { LogoLoader } from './logo-loader';
import { PlayerSettings } from './player-settings';
import { VideoPlayer, type PlayerSubtitle } from './video-player';
import {
  addMagnet,
  buildMagnet,
  getLibrary,
  largestFileIndex,
  recordPlayback,
  streamUrl,
  waitUntilLive,
  type TorrentProgress,
} from '@/lib/local-engine';
import { isBrowserPlayableFilename } from '@/lib/media-compatibility';
import { playbackKey } from '@/lib/library';
import { rankStreams, streamKey } from '@/lib/stream-select';

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
  season?: number;
  episode?: number;
}) {
  const core = useCore();
  const refreshLibrary = core.refreshLibrary;
  const navigate = useNavigate();

  const [sources, setSources] = useState<Stream[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [status, setStatus] = useState<Status>('loading');
  const [statusText, setStatusText] = useState('Finding sources');
  const [detailText, setDetailText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsCore, setNeedsCore] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [subtitleTracks, setSubtitleTracks] = useState<PlayerSubtitle[]>([]);
  const [activeSubtitleId, setActiveSubtitleId] = useState<string | null>(null);
  const [resumeAt, setResumeAt] = useState(0);

  const attemptRef = useRef(0);
  const targetRef = useRef(STAGE.sources);
  const playbackConnection = useRef<Awaited<ReturnType<typeof core.connect>> | null>(null);
  const itemKey = playbackKey(mediaType, mediaId, season, episode);

  // The fill eases toward whatever ceiling the current stage set, so it keeps
  // creeping while a stage takes its time and never jumps backwards.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setProgress((current) => current + (targetRef.current - current) * 0.14);
    }, 220);
    return () => window.clearInterval(timer);
  }, []);

  function setStage(target: number, text?: string) {
    targetRef.current = target;
    if (text) setStatusText(text);
  }

  async function start(list: Stream[], startIndex: number, auto: boolean) {
    const attempt = (attemptRef.current += 1);
    const stale = () => attemptRef.current !== attempt;

    setStatus('starting');
    setError(null);
    setNeedsCore(false);
    setVideoUrl(null);
    setDetailText(null);
    setProgress(0);
    setStage(STAGE.core, 'Connecting to Cubo Core');

    let connection;
    try {
      connection = await core.connect();
      playbackConnection.current = connection;
      try {
        const library = await getLibrary(connection);
        const previous = library.history.find((item) => item.key === itemKey);
        setResumeAt(previous && previous.progress < 0.9 ? previous.positionSeconds : 0);
      } catch {
        setResumeAt(0);
      }
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

      try {
        setStage(
          STAGE.opening,
          index > startIndex ? `Trying source ${index + 1}` : 'Opening source',
        );
        const added = await addMagnet(connection, buildMagnet(stream), {
          mediaKey: itemKey,
          title,
        });
        if (stale()) return;

        const fileIndex = stream.fileIdx ?? largestFileIndex(added.files);
        const filename = added.files[fileIndex]?.name ?? stream.filename ?? '';
        if (!isBrowserPlayableFilename(filename, `${stream.name} ${stream.title}`)) {
          throw new Error('This source uses video or audio the browser cannot play.');
        }

        const id = added.id ?? added.infoHash;
        if (id === null || id === '') throw new Error('Cubo Core did not return a torrent ID');

        setStage(STAGE.buffering, 'Buffering the first pieces');
        await waitUntilLive(connection, id, {
          onProgress: (stats) => {
            if (stale()) return;
            setStage(bufferingTarget(stats));
            setDetailText(describe(stats));
          },
        });
        if (stale()) return;

        const url = streamUrl(connection, id, fileIndex);
        setStage(STAGE.ready, 'Ready');
        setProgress(1);
        // Let the logo finish filling before the picture takes over.
        window.setTimeout(() => {
          if (stale()) return;
          setVideoUrl(url);
          setStatus('ready');
        }, 480);
        return;
      } catch (reason) {
        if (stale()) return;
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
    setStage(STAGE.sources, 'Finding sources');
    setError(null);

    catalog.streams
      .get(mediaType, imdbId, season, episode)
      .then((found) => {
        if (cancelled) return;
        const ranked = rankStreams(found);
        setSources(ranked);
        setHiddenCount(found.length - ranked.length);
        if (ranked.length === 0) {
          setStatus('error');
          setError('No browser-compatible sources were found for this title.');
          return;
        }
        void startRef.current(ranked, 0, true);
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
        setError('Could not load sources for this title.');
      });

    return () => {
      cancelled = true;
    };
  }, [mediaType, imdbId, season, episode]);

  useEffect(() => {
    if (!imdbId) return;
    let cancelled = false;
    void catalog.subtitles
      .get(mediaType, imdbId, season, episode)
      .then((tracks) => {
        if (!cancelled) setSubtitleTracks(prepareSubtitles(tracks));
      })
      .catch(() => {
        if (!cancelled) setSubtitleTracks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaType, imdbId, season, episode]);

  const savePlaybackProgress = useCallback(
    (
      positionSeconds: number,
      durationSeconds: number,
      watchedDeltaSeconds: number,
      sessionStarted: boolean,
    ) => {
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
        season: season ?? null,
        episode: episode ?? null,
        positionSeconds,
        durationSeconds,
        watchedDeltaSeconds,
        sessionStarted,
        watchHref: `/watch/${mediaType}/${mediaId}${season != null && episode != null ? `?season=${season}&episode=${episode}` : ''}`,
        detailHref: backHref,
      })
        .then(() => refreshLibrary())
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
      season,
      episode,
      backHref,
      refreshLibrary,
    ],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (panelOpen) setPanelOpen(false);
      else if (!document.fullscreenElement) navigate(backHref);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [panelOpen, navigate, backHref]);

  const backdrop = backdropUrl(backdropPath, 'w780');
  const busy = status === 'loading' || status === 'starting';

  return (
    <div className="fixed inset-0 flex flex-col bg-black">
      {videoUrl && status === 'ready' ? (
        <VideoPlayer
          src={videoUrl}
          title={title}
          subtitle={subtitle}
          logoPath={logoPath}
          backHref={backHref}
          onOpenSettings={() => setPanelOpen(true)}
          subtitles={subtitleTracks}
          activeSubtitleId={activeSubtitleId}
          initialTime={resumeAt}
          onPlaybackProgress={savePlaybackProgress}
          onError={() => {
            setStatus('error');
            setError('The browser could not play this source. Try another one.');
          }}
        />
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

          <Link
            href={backHref}
            className="absolute left-4 top-4 flex items-center gap-2 text-[0.8rem] text-white/50 transition-colors hover:text-white sm:left-6 sm:top-5"
          >
            <CaretLeft className="size-4" />
            Back
          </Link>

          <div className="relative flex w-full max-w-xl flex-col items-center text-center">
            <LogoLoader
              logoPath={logoPath}
              title={title}
              progress={busy ? Math.min(progress, 1) : null}
            />

            {busy ? (
              <>
                <p className="mt-9 text-[0.82rem] text-white/70">
                  {statusText}
                  <span className="ml-0.5 inline-flex">
                    <Dot delay="0ms" />
                    <Dot delay="160ms" />
                    <Dot delay="320ms" />
                  </span>
                </p>
                <p className="mt-2 h-4 text-[0.72rem] tabular-nums text-white/35">
                  {detailText ?? (subtitle || 'Streams start once enough pieces have arrived')}
                </p>
              </>
            ) : (
              <>
                <p className="mt-9 text-sm leading-relaxed text-white/80">{error}</p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  {needsCore ? (
                    <button
                      type="button"
                      onClick={core.openSettings}
                      className="cursor-pointer rounded-full bg-white px-5 py-2.5 text-sm font-medium text-black transition hover:bg-accent"
                    >
                      Core settings
                    </button>
                  ) : null}
                  {sources.length > 0 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void start(sources, 0, true)}
                        className="cursor-pointer rounded-full border border-white/20 px-5 py-2.5 text-sm font-medium text-white transition hover:border-white/40 hover:bg-white/10"
                      >
                        Try again
                      </button>
                      <button
                        type="button"
                        onClick={() => setPanelOpen(true)}
                        className="cursor-pointer rounded-full border border-white/20 px-5 py-2.5 text-sm font-medium text-white/80 transition hover:border-white/40 hover:bg-white/10"
                      >
                        Choose a source
                      </button>
                    </>
                  ) : null}
                  <Link
                    href={backHref}
                    className="rounded-full border border-white/20 px-5 py-2.5 text-sm font-medium text-white/80 transition hover:border-white/40 hover:bg-white/10"
                  >
                    Back to details
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {panelOpen ? (
        <PlayerSettings
          sources={sources}
          activeKey={activeKey}
          hiddenCount={hiddenCount}
          subtitles={subtitleTracks}
          activeSubtitleId={activeSubtitleId}
          onPickSubtitle={setActiveSubtitleId}
          onPickSource={(index) => {
            setPanelOpen(false);
            void start(sources, index, false);
          }}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}
    </div>
  );
}

function bufferingTarget(stats: TorrentProgress): number {
  const ratio = Math.min(1, stats.downloadedBytes / BUFFER_TARGET_BYTES);
  return STAGE.buffering + (STAGE.bufferingFull - STAGE.buffering) * ratio;
}

function describe(stats: TorrentProgress): string | null {
  const parts = [
    stats.speed,
    stats.peers != null ? `${stats.peers} peer${stats.peers === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="animate-pulse text-white/70"
      style={{ animationDelay: delay, animationDuration: '1.2s' }}
    >
      .
    </span>
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
      src: apiUrl(`/api/subtitle-file?url=${encodeURIComponent(track.url)}`),
      language: track.language,
      label,
    });
    if (prepared.length >= 18) break;
  }

  return prepared;
}
