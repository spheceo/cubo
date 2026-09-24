//! Playback sessions: one object per viewing that owns the source torrent,
//! the chosen file, how it plays (direct or remuxed HLS), and the viewer's
//! position.
//!
//! Every playback decision in Core reads from here instead of inferring
//! "what is the viewer doing" from request timing. The session's torrent
//! uses ordinary whole-file storage, so a file being watched is never
//! evicted underneath the player; cache limits apply to everything else.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use librqbit::api::TorrentIdOrHash;
use librqbit::storage::filesystem::FilesystemStorageFactory;
use librqbit::storage::StorageFactoryExt;
use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent};
use librqbit_core::magnet::Magnet;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::mkv_index::{self, ByteSource, MkvIndex};
use crate::remuxer::{RemuxInput, RemuxStatus, Remuxer};
use crate::segment_plan::SegmentPlan;
use crate::store::CoreStore;
use crate::transcode::{MediaProbe, TranscodeManager};

type ManagedTorrentHandle = Arc<ManagedTorrent>;

/// Magnet metadata can take a while on a cold swarm; past this the source
/// is treated as dead. Clients race backup sources long before this, so it
/// only bounds how long a hopeless source holds a slot.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(45);
/// Probe results and keyframe indexes kept per source file. A prefetch
/// fills them so the real session skips straight to ready.
const MEDIA_CACHE_ENTRIES: usize = 64;
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
/// A session nobody has heard from in this long is closed. The client
/// heartbeats every few seconds even while paused, so this only fires
/// after the tab is gone.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// A remux that has had room to convert but received no source data for
/// this long means the swarm stopped delivering.
const STALL_FAILURE: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub magnet: String,
    #[serde(default)]
    pub media_key: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub file_index: Option<usize>,
    #[serde(default)]
    pub resume_seconds: Option<f64>,
    /// Whether the browser can decode HEVC through MSE.
    #[serde(default)]
    pub hevc: bool,
    /// Extra peers to connect to immediately (tests, local seeds).
    #[serde(default)]
    pub peers: Vec<SocketAddr>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Resolving,
    Probing,
    Ready,
    Failed,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Direct,
    Hls,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    /// `metadata_timeout`, `no_file`, `unsupported`, `probe_failed`,
    /// `stalled`, `disk_full`, `internal`.
    pub code: &'static str,
    pub message: String,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone)]
struct Source {
    torrent_id: usize,
    info_hash: String,
    handle: ManagedTorrentHandle,
    file_index: usize,
    file_name: String,
    file_len: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub resolved_ms: Option<u64>,
    pub initialized_ms: Option<u64>,
    pub probed_ms: Option<u64>,
    pub ready_ms: Option<u64>,
    pub first_media_ms: Option<u64>,
}

struct Inner {
    phase: Phase,
    failure: Option<Failure>,
    source: Option<Source>,
    mode: Option<Mode>,
    duration: Option<f64>,
    remuxer: Option<Arc<Remuxer>>,
    timeline: Timeline,
    last_seen: Instant,
    position: f64,
    playing: bool,
}

pub struct PlaybackSession {
    pub id: String,
    media_key: Option<String>,
    title: Option<String>,
    resume_seconds: f64,
    created: Instant,
    inner: Mutex<Inner>,
    startup: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentProgress {
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub download_mbps: f64,
    pub peers: u32,
    pub finished: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub id: String,
    pub phase: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Failure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<Mode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub torrent_id: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub torrent: Option<TorrentProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remux: Option<RemuxStatus>,
    pub timeline: Timeline,
}

impl PlaybackSession {
    fn elapsed_ms(&self) -> u64 {
        self.created.elapsed().as_millis() as u64
    }

    fn update<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> R {
        f(&mut self.inner.lock().unwrap())
    }

    fn fail(&self, failure: Failure) {
        tracing::warn!(
            target: "session",
            session = %self.id,
            code = failure.code,
            error = %failure.message,
            "playback session failed"
        );
        self.update(|inner| {
            if matches!(inner.phase, Phase::Closed) {
                return;
            }
            inner.phase = Phase::Failed;
            inner.failure = Some(failure);
            if let Some(remuxer) = inner.remuxer.take() {
                remuxer.close();
            }
        });
    }

    pub fn touch(&self) {
        self.update(|inner| inner.last_seen = Instant::now());
    }

    pub fn is_live(&self) -> bool {
        self.update(|inner| !matches!(inner.phase, Phase::Failed | Phase::Closed))
    }

    pub fn info_hash(&self) -> Option<String> {
        self.update(|inner| inner.source.as_ref().map(|source| source.info_hash.clone()))
    }

    pub fn torrent_id(&self) -> Option<usize> {
        self.update(|inner| inner.source.as_ref().map(|source| source.torrent_id))
    }

    pub fn mode(&self) -> Option<Mode> {
        self.update(|inner| inner.mode)
    }

    pub fn file_index(&self) -> Option<usize> {
        self.update(|inner| inner.source.as_ref().map(|source| source.file_index))
    }

    pub fn remuxer(&self) -> Option<Arc<Remuxer>> {
        self.update(|inner| inner.remuxer.clone())
    }

    pub fn heartbeat(&self, position: f64, playing: bool) {
        let remuxer = self.update(|inner| {
            inner.last_seen = Instant::now();
            if position.is_finite() && position >= 0.0 {
                inner.position = position;
            }
            inner.playing = playing;
            inner.remuxer.clone()
        });
        if let Some(remuxer) = remuxer {
            remuxer.set_playhead(position);
        }
    }

    /// The first media bytes the player actually received.
    pub fn note_media_served(&self) {
        let elapsed = self.elapsed_ms();
        let first = self.update(|inner| {
            inner.last_seen = Instant::now();
            if inner.timeline.first_media_ms.is_none() {
                inner.timeline.first_media_ms = Some(elapsed);
                true
            } else {
                false
            }
        });
        if first {
            let timeline = self.update(|inner| inner.timeline.clone());
            tracing::info!(
                target: "session",
                session = %self.id,
                media_key = self.media_key.as_deref().unwrap_or("-"),
                resolved_ms = timeline.resolved_ms.unwrap_or(0),
                initialized_ms = timeline.initialized_ms.unwrap_or(0),
                probed_ms = timeline.probed_ms.unwrap_or(0),
                ready_ms = timeline.ready_ms.unwrap_or(0),
                first_media_ms = elapsed,
                "session startup timeline"
            );
        }
    }
}

pub struct SessionManager {
    rqbit: Arc<librqbit::Session>,
    rqbit_port: u16,
    http: reqwest::Client,
    transcode: Arc<TranscodeManager>,
    store: CoreStore,
    download_dir: Arc<RwLock<PathBuf>>,
    sessions_dir: PathBuf,
    /// `<info hash>.torrent` files, so reopening a source never waits on the
    /// swarm for metadata Core already had (rqbit forgets torrents on
    /// restart, and even a managed torrent re-fetches it from peers when
    /// re-added by magnet).
    metadata_dir: PathBuf,
    sessions: Mutex<HashMap<String, Arc<PlaybackSession>>>,
    /// Probe + keyframe index per `info_hash:file_index`.
    media_cache: Mutex<HashMap<String, (MediaProbe, Option<MkvIndex>)>>,
    /// Prefetches in flight, by `info_hash:file_index` (or magnet while the
    /// hash is unknown). Their torrents count as live so maintenance does not
    /// pause them mid-warm-up.
    prefetching: Mutex<HashMap<String, Option<usize>>>,
    /// Torrents a finished prefetch parked: kept paused (not downloaded in
    /// the background) until a session actually plays them.
    parked: Mutex<HashSet<usize>>,
    /// Set once any client has used sessions. Cache maintenance then trusts
    /// explicit liveness instead of the legacy pipeline's timing guesses.
    used: std::sync::atomic::AtomicBool,
}

impl SessionManager {
    pub fn new(
        rqbit: Arc<librqbit::Session>,
        rqbit_port: u16,
        transcode: Arc<TranscodeManager>,
        store: CoreStore,
        download_dir: Arc<RwLock<PathBuf>>,
        sessions_dir: PathBuf,
    ) -> Arc<Self> {
        let _ = std::fs::remove_dir_all(&sessions_dir);
        let metadata_dir = sessions_dir.with_file_name("torrent-meta");
        let manager = Arc::new(Self {
            rqbit,
            rqbit_port,
            http: reqwest::Client::new(),
            transcode,
            store,
            download_dir,
            sessions_dir,
            metadata_dir,
            sessions: Mutex::new(HashMap::new()),
            media_cache: Mutex::new(HashMap::new()),
            prefetching: Mutex::new(HashMap::new()),
            parked: Mutex::new(HashSet::new()),
            used: std::sync::atomic::AtomicBool::new(false),
        });
        let sweeper = Arc::downgrade(&manager);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;
                let Some(manager) = sweeper.upgrade() else {
                    return;
                };
                manager.sweep().await;
            }
        });
        manager
    }

    /// A manager over an offline rqbit session, for tests of other routes.
    #[cfg(test)]
    pub async fn for_tests(root: &std::path::Path, transcode: Arc<TranscodeManager>, store: CoreStore) -> Arc<Self> {
        let rqbit = librqbit::Session::new_with_opts(
            root.join("rqbit"),
            librqbit::SessionOptions {
                dht: None,
                disable_trackers: true,
                disable_local_service_discovery: true,
                persistence: None,
                listen: None,
                ..Default::default()
            },
        )
        .await
        .expect("offline rqbit session");
        Self::new(
            rqbit,
            1,
            transcode,
            store,
            Arc::new(RwLock::new(root.join("downloads"))),
            root.join("sessions"),
        )
    }

    pub fn get(&self, id: &str) -> Option<Arc<PlaybackSession>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    /// Info hashes of every session still playing or starting. Cache
    /// maintenance never evicts or pauses these.
    pub fn live_info_hashes(&self) -> HashSet<String> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .filter(|session| session.is_live())
            .filter_map(|session| session.info_hash())
            .collect()
    }

    /// rqbit torrent ids (as the HTTP API spells them) of live sessions and
    /// prefetches still warming up.
    pub fn live_torrent_ids(&self) -> HashSet<String> {
        let mut ids: HashSet<String> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|session| session.is_live())
            .filter_map(|session| session.torrent_id())
            .map(|id| id.to_string())
            .collect();
        ids.extend(
            self.prefetching
                .lock()
                .unwrap()
                .values()
                .flatten()
                .map(|id| id.to_string()),
        );
        ids
    }

    /// Torrents a prefetch warmed and parked. Maintenance keeps them paused
    /// so a guess about what the viewer might watch never downloads a whole
    /// file in the background.
    pub fn parked_torrent_ids(&self) -> HashSet<String> {
        self.parked.lock().unwrap().iter().map(|id| id.to_string()).collect()
    }

    /// Forgets saved torrent metadata and media probes (cache clear).
    pub fn clear_metadata(&self) {
        self.media_cache.lock().unwrap().clear();
        self.parked.lock().unwrap().clear();
        let _ = std::fs::remove_dir_all(&self.metadata_dir);
    }

    /// Fails every live session, e.g. when the disk fills up.
    pub fn fail_live(&self, code: &'static str, message: &str) {
        let sessions: Vec<Arc<PlaybackSession>> =
            self.sessions.lock().unwrap().values().cloned().collect();
        for session in sessions.into_iter().filter(|session| session.is_live()) {
            session.fail(Failure::new(code, message));
        }
    }

    pub async fn close_all(&self) {
        let sessions: Vec<Arc<PlaybackSession>> =
            self.sessions.lock().unwrap().drain().map(|(_, session)| session).collect();
        for session in sessions {
            self.shut_down(&session).await;
        }
    }

    /// Closes sessions playing a torrent (by rqbit id or info hash) that the
    /// viewer is deleting from the cache.
    pub async fn close_torrent(&self, id_or_hash: &str) {
        let matching: Vec<String> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|session| {
                session.torrent_id().map(|id| id.to_string()).as_deref() == Some(id_or_hash)
                    || session.info_hash().as_deref() == Some(id_or_hash)
            })
            .map(|session| session.id.clone())
            .collect();
        for id in matching {
            self.close(&id).await;
        }
    }

    pub fn has_live_sessions(&self) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .any(|session| session.is_live())
    }

    pub fn ever_used(&self) -> bool {
        self.used.load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn create(self: &Arc<Self>, request: CreateSessionRequest) -> Arc<PlaybackSession> {
        self.used.store(true, std::sync::atomic::Ordering::Release);
        let id = uuid::Uuid::new_v4().simple().to_string();
        let session = Arc::new(PlaybackSession {
            id: id.clone(),
            media_key: request.media_key.clone(),
            title: request.title.clone(),
            resume_seconds: request.resume_seconds.unwrap_or(0.0).max(0.0),
            created: Instant::now(),
            inner: Mutex::new(Inner {
                phase: Phase::Resolving,
                failure: None,
                source: None,
                mode: None,
                duration: None,
                remuxer: None,
                timeline: Timeline::default(),
                last_seen: Instant::now(),
                position: request.resume_seconds.unwrap_or(0.0).max(0.0),
                playing: false,
            }),
            startup: Mutex::new(None),
        });
        self.sessions.lock().unwrap().insert(id, session.clone());
        tracing::info!(
            target: "session",
            session = %session.id,
            media_key = session.media_key.as_deref().unwrap_or("-"),
            file_index = request.file_index.map(|index| index as i64).unwrap_or(-1),
            resume_seconds = session.resume_seconds,
            "playback session created"
        );
        let manager = self.clone();
        let task_session = session.clone();
        let task = tokio::spawn(async move {
            if let Err(failure) = manager.start(&task_session, request).await {
                task_session.fail(failure);
            }
        });
        *session.startup.lock().unwrap() = Some(task);
        session
    }

    pub async fn close(&self, id: &str) -> bool {
        let Some(session) = self.sessions.lock().unwrap().remove(id) else {
            return false;
        };
        self.shut_down(&session).await;
        true
    }

    async fn shut_down(&self, session: &PlaybackSession) {
        if let Some(task) = session.startup.lock().unwrap().take() {
            task.abort();
        }
        let (remuxer, source, served) = session.update(|inner| {
            inner.phase = Phase::Closed;
            (
                inner.remuxer.take(),
                inner.source.clone(),
                inner.timeline.first_media_ms.is_some(),
            )
        });
        if let Some(remuxer) = remuxer {
            remuxer.close();
        }
        // The file stays on disk as ordinary cache. Stop spending bandwidth on
        // it unless another live session is watching the same torrent. A
        // source that never played (it lost a startup race, or the viewer
        // backed out at once) stays parked rather than downloading in full
        // once nothing is playing.
        if let Some(source) = source {
            if !self.live_info_hashes().contains(&source.info_hash) {
                if !served {
                    self.parked.lock().unwrap().insert(source.torrent_id);
                }
                let _ = self.rqbit.pause(&source.handle).await;
            }
        }
        tracing::info!(target: "session", session = %session.id, "playback session closed");
    }

    async fn sweep(&self) {
        let sessions: Vec<Arc<PlaybackSession>> =
            self.sessions.lock().unwrap().values().cloned().collect();
        for session in sessions {
            let (idle, phase, remuxer) = session.update(|inner| {
                (inner.last_seen.elapsed(), inner.phase, inner.remuxer.clone())
            });
            if idle > IDLE_TIMEOUT || matches!(phase, Phase::Failed) && idle > Duration::from_secs(60) {
                self.close(&session.id).await;
                continue;
            }
            if let Some(remuxer) = remuxer {
                let starved = remuxer.status().starved_seconds.unwrap_or(0.0);
                if starved > STALL_FAILURE.as_secs_f64() {
                    session.fail(Failure::new(
                        "stalled",
                        "The source stopped sending data.",
                    ));
                }
            }
        }
    }

    fn stream_url(&self, torrent_id: usize, file_index: usize) -> String {
        format!(
            "http://127.0.0.1:{}/torrents/{torrent_id}/stream/{file_index}",
            self.rqbit_port
        )
    }

    pub fn source_stream_url(&self, session: &PlaybackSession) -> Option<String> {
        session.update(|inner| {
            inner
                .source
                .as_ref()
                .map(|source| self.stream_url(source.torrent_id, source.file_index))
        })
    }

    pub fn status(&self, session: &PlaybackSession) -> SessionStatus {
        let (phase, failure, source, mode, duration, remuxer, timeline) = session.update(|inner| {
            (
                inner.phase,
                inner.failure.clone(),
                inner.source.clone(),
                inner.mode,
                inner.duration,
                inner.remuxer.clone(),
                inner.timeline.clone(),
            )
        });
        let torrent = source.as_ref().map(|source| {
            let stats = source.handle.stats();
            let (download_mbps, peers) = stats
                .live
                .as_ref()
                .map(|live| (live.download_speed.mbps, live.snapshot.peer_stats.live))
                .unwrap_or((0.0, 0));
            TorrentProgress {
                progress_bytes: stats.progress_bytes,
                total_bytes: stats.total_bytes,
                download_mbps,
                peers,
                finished: stats.finished,
            }
        });
        SessionStatus {
            id: session.id.clone(),
            phase,
            error: failure,
            mode,
            duration_seconds: duration,
            torrent_id: source.as_ref().map(|source| source.torrent_id),
            info_hash: source.as_ref().map(|source| source.info_hash.clone()),
            file_index: source.as_ref().map(|source| source.file_index),
            file_name: source.as_ref().map(|source| source.file_name.clone()),
            torrent,
            remux: remuxer.map(|remuxer| remuxer.status()),
            timeline,
        }
    }

    async fn start(
        self: &Arc<Self>,
        session: &Arc<PlaybackSession>,
        request: CreateSessionRequest,
    ) -> Result<(), Failure> {
        let source = self
            .resolve(
                &request,
                session.media_key.clone(),
                session.title.clone(),
                &session.id,
            )
            .await?;
        // Played for real now: back to normal download scheduling.
        self.parked.lock().unwrap().remove(&source.torrent_id);
        let resolved = session.elapsed_ms();
        session.update(|inner| {
            inner.source = Some(source.clone());
            inner.phase = Phase::Probing;
            inner.timeline.resolved_ms = Some(resolved);
        });

        tokio::time::timeout(INITIALIZE_TIMEOUT, source.handle.wait_until_initialized())
            .await
            .map_err(|_| Failure::new("metadata_timeout", "The torrent did not start in time."))?
            .map_err(|error| Failure::new("internal", format!("The torrent failed to start: {error:#}")))?;
        let initialized = session.elapsed_ms();
        session.update(|inner| inner.timeline.initialized_ms = Some(initialized));

        let url = self.stream_url(source.torrent_id, source.file_index);
        let (probe, index) = self.media_info(&source).await?;
        // The skip-segments endpoint reads chapters from this cache entry.
        self.transcode
            .remember_probe(&format!("{}:{}", source.torrent_id, source.file_index), probe.clone())
            .await;
        let probed = session.elapsed_ms();
        session.update(|inner| inner.timeline.probed_ms = Some(probed));

        let mode = choose_mode(&probe, &source.file_name, request.hevc)?;
        let duration = index
            .as_ref()
            .and_then(|index| index.duration_seconds)
            .or(probe.duration_seconds);
        let remuxer = match mode {
            Mode::Direct => None,
            Mode::Hls => {
                let ffmpeg = self
                    .transcode
                    .ffmpeg_path()
                    .ok_or_else(|| Failure::new("unsupported", "ffmpeg is not available on this Core."))?
                    .to_path_buf();
                let duration = duration
                    .ok_or_else(|| Failure::new("probe_failed", "The source does not report its length."))?;
                let (plan, origin) = plan_for(index.as_ref(), duration);
                tracing::info!(
                    target: "session",
                    session = %session.id,
                    segments = plan.len(),
                    exact = plan.is_exact(),
                    duration,
                    origin,
                    "segment plan ready"
                );
                let remuxer = Remuxer::new(
                    RemuxInput {
                        ffmpeg,
                        url,
                        audio_stream_index: probe.audio_stream_index,
                        audio_copy: probe.audio_copyable(),
                        hevc: probe.video_codec.as_deref() == Some("hevc"),
                        origin,
                    },
                    plan,
                    self.sessions_dir.join(&session.id),
                );
                remuxer.warm(session.update(|inner| inner.position));
                Some(remuxer)
            }
        };

        let ready = session.elapsed_ms();
        let closed = session.update(|inner| {
            if matches!(inner.phase, Phase::Closed) {
                return true;
            }
            inner.mode = Some(mode);
            inner.duration = duration;
            inner.remuxer = remuxer.clone();
            inner.phase = Phase::Ready;
            inner.timeline.ready_ms = Some(ready);
            false
        });
        if closed {
            if let Some(remuxer) = remuxer {
                remuxer.close();
            }
            return Ok(());
        }
        tracing::info!(
            target: "session",
            session = %session.id,
            mode = ?mode,
            file = %source.file_name,
            video = probe.video_codec.as_deref().unwrap_or("-"),
            audio = probe.audio_codec.as_deref().unwrap_or("-"),
            ready_ms = ready,
            "playback session ready"
        );
        Ok(())
    }

    /// Probe and keyframe index for a source file, from the cache when a
    /// prefetch (or an earlier session) already read them.
    async fn media_info(&self, source: &Source) -> Result<(MediaProbe, Option<MkvIndex>), Failure> {
        let key = format!("{}:{}", source.info_hash, source.file_index);
        if let Some(cached) = self.media_cache.lock().unwrap().get(&key).cloned() {
            return Ok(cached);
        }
        let url = self.stream_url(source.torrent_id, source.file_index);
        let is_mkv = source.file_name.to_ascii_lowercase().ends_with(".mkv");
        let index_source = HttpSource {
            client: self.http.clone(),
            url: url.clone(),
            len: source.file_len,
        };
        let (probe, index) = tokio::join!(self.transcode.probe(&url), async {
            if is_mkv {
                Some(mkv_index::read_index(&index_source).await)
            } else {
                None
            }
        });
        let probe = probe.map_err(|error| Failure::new("probe_failed", error))?;
        let index = match index {
            Some(Ok(index)) => Some(index),
            Some(Err(error)) => {
                tracing::info!(target: "session", file = %source.file_name, %error, "no keyframe index; using a time grid");
                None
            }
            None => None,
        };
        let mut cache = self.media_cache.lock().unwrap();
        if cache.len() >= MEDIA_CACHE_ENTRIES {
            cache.clear();
        }
        cache.insert(key, (probe.clone(), index.clone()));
        Ok((probe, index))
    }

    fn metadata_path(&self, info_hash: &str) -> PathBuf {
        self.metadata_dir.join(format!("{info_hash}.torrent"))
    }

    fn save_metadata(&self, info_hash: &str, handle: &ManagedTorrentHandle) {
        let path = self.metadata_path(info_hash);
        if path.exists() {
            return;
        }
        let Ok(bytes) = handle.with_metadata(|metadata| metadata.torrent_bytes.clone()) else {
            return;
        };
        if bytes.is_empty() {
            return;
        }
        let _ = std::fs::create_dir_all(&self.metadata_dir);
        let temp = path.with_extension("tmp");
        if std::fs::write(&temp, &bytes).is_ok() {
            let _ = std::fs::rename(&temp, &path);
        }
    }

    /// Adds (or reuses) the torrent and selects the file to play.
    ///
    /// Order matters for speed: a torrent rqbit already manages is used as
    /// is, saved metadata is added from disk, and only an unknown source
    /// goes to the swarm. rqbit resolves a magnet's metadata from peers
    /// *before* noticing it already has the torrent, so re-adding by magnet
    /// could hang for the full timeout on a file that was already
    /// downloaded.
    async fn resolve(
        &self,
        request: &CreateSessionRequest,
        media_key: Option<String>,
        title: Option<String>,
        log_id: &str,
    ) -> Result<Source, Failure> {
        let download_dir = self.download_dir.read().await.clone();
        let options = AddTorrentOptions {
            overwrite: true,
            output_folder: Some(download_dir.to_string_lossy().into_owned()),
            only_files: request.file_index.map(|index| vec![index]),
            only_files_regex: if request.file_index.is_none() {
                episode_file_regex(media_key.as_deref())
            } else {
                None
            },
            initial_peers: (!request.peers.is_empty()).then(|| request.peers.clone()),
            // Whole-file storage: the file being watched is never evicted
            // piecemeal underneath the player.
            storage_factory: Some(FilesystemStorageFactory::default().boxed()),
            ..Default::default()
        };

        let magnet_hash = Magnet::parse(&request.magnet)
            .ok()
            .and_then(|magnet| magnet.as_id20());
        let managed = magnet_hash.and_then(|hash| self.rqbit.get(TorrentIdOrHash::Hash(hash)));

        let (torrent_id, handle, existing) = if let Some(handle) = managed {
            (handle.id(), handle, true)
        } else {
            let saved = magnet_hash
                .map(|hash| self.metadata_path(&hash.as_string()))
                .and_then(|path| std::fs::read(path).ok());
            let add = match saved {
                Some(bytes) => AddTorrent::from_bytes(bytes),
                None => AddTorrent::from_url(request.magnet.clone()),
            };
            let response = tokio::time::timeout(RESOLVE_TIMEOUT, self.rqbit.add_torrent(add, Some(options)))
                .await
                .map_err(|_| Failure::new("metadata_timeout", "Could not find peers for this source in time."))?
                .map_err(|error| Failure::new("metadata_timeout", format!("The source could not be opened: {error:#}")))?;
            match response {
                AddTorrentResponse::Added(id, handle) => (id, handle, false),
                AddTorrentResponse::AlreadyManaged(id, handle) => (id, handle, true),
                AddTorrentResponse::ListOnly(_) => {
                    return Err(Failure::new("internal", "The torrent was only listed."));
                }
            }
        };
        let info_hash = handle.info_hash().as_string();
        self.save_metadata(&info_hash, &handle);

        let file_index = match request.file_index {
            Some(index) => Some(index),
            // A reused season pack has other episodes selected too; the
            // regex finds this episode among them.
            None if existing => episode_file_index(&handle, media_key.as_deref()),
            None => None,
        };
        let (file_index, relative, file_len) = pick_file(&handle, file_index)?;
        if existing {
            // A season pack reopened for a different episode must add that file.
            let mut wanted: HashSet<usize> = handle.only_files().unwrap_or_default().into_iter().collect();
            if !wanted.contains(&file_index) && handle.only_files().is_some() {
                wanted.insert(file_index);
                self.rqbit
                    .update_only_files(&handle, &wanted)
                    .await
                    .map_err(|error| Failure::new("internal", format!("Could not select the episode file: {error:#}")))?;
            }
            if handle.is_paused() {
                self.rqbit
                    .unpause(&handle)
                    .await
                    .map_err(|error| Failure::new("internal", format!("Could not resume the torrent: {error:#}")))?;
            }
        }

        let absolute = handle.output_folder().join(&relative);
        if let Err(error) = self
            .store
            .touch_cache(
                Some(torrent_id as u64),
                info_hash.clone(),
                media_key,
                title,
                vec![absolute.to_string_lossy().into_owned()],
            )
            .await
        {
            tracing::warn!(target: "session", %error, "could not record the session in the cache index");
        }
        let file_name = relative
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| relative.to_string_lossy().into_owned());
        tracing::info!(
            target: "session",
            session = %log_id,
            torrent_id,
            info_hash = %info_hash,
            file_index,
            file = %file_name,
            file_bytes = file_len,
            reused = existing,
            "session source resolved"
        );
        Ok(Source {
            torrent_id,
            info_hash,
            handle,
            file_index,
            file_name,
            file_len,
        })
    }

    /// Warms a source the viewer is likely to play next: metadata, file
    /// selection, probe and keyframe index (which pulls the header pieces
    /// onto disk). The torrent is then parked so the guess costs a few
    /// megabytes, not a whole file. A later session on the same source
    /// skips straight to ready. Fire-and-forget; duplicates are ignored.
    pub fn prefetch(self: &Arc<Self>, request: CreateSessionRequest) {
        let key = Magnet::parse(&request.magnet)
            .ok()
            .and_then(|magnet| magnet.as_id20())
            .map(|hash| format!("{}:{}", hash.as_string(), request.file_index.map(|i| i as i64).unwrap_or(-1)))
            .unwrap_or_else(|| request.magnet.clone());
        {
            let mut prefetching = self.prefetching.lock().unwrap();
            if prefetching.contains_key(&key) {
                return;
            }
            prefetching.insert(key.clone(), None);
        }
        let manager = self.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let result = manager.run_prefetch(&key, &request).await;
            let torrent_id = manager.prefetching.lock().unwrap().remove(&key).flatten();
            match result {
                Ok(source) => {
                    let playing = manager.live_info_hashes().contains(&source.info_hash);
                    if !playing {
                        manager.parked.lock().unwrap().insert(source.torrent_id);
                        let _ = manager.rqbit.pause(&source.handle).await;
                    }
                    tracing::info!(
                        target: "session",
                        media_key = request.media_key.as_deref().unwrap_or("-"),
                        file = %source.file_name,
                        warm_ms = started.elapsed().as_millis() as u64,
                        "source prefetched"
                    );
                }
                Err(failure) => {
                    if let Some(id) = torrent_id {
                        if !manager.live_torrent_ids().contains(&id.to_string()) {
                            if let Some(handle) = manager.rqbit.get(TorrentIdOrHash::Id(id)) {
                                manager.parked.lock().unwrap().insert(id);
                                let _ = manager.rqbit.pause(&handle).await;
                            }
                        }
                    }
                    tracing::info!(
                        target: "session",
                        media_key = request.media_key.as_deref().unwrap_or("-"),
                        code = failure.code,
                        error = %failure.message,
                        "source prefetch gave up"
                    );
                }
            }
        });
    }

    async fn run_prefetch(&self, key: &str, request: &CreateSessionRequest) -> Result<Source, Failure> {
        let source = self
            .resolve(request, request.media_key.clone(), request.title.clone(), "prefetch")
            .await?;
        if let Some(slot) = self.prefetching.lock().unwrap().get_mut(key) {
            *slot = Some(source.torrent_id);
        }
        tokio::time::timeout(INITIALIZE_TIMEOUT, source.handle.wait_until_initialized())
            .await
            .map_err(|_| Failure::new("metadata_timeout", "The torrent did not start in time."))?
            .map_err(|error| Failure::new("internal", format!("The torrent failed to start: {error:#}")))?;
        self.media_info(&source).await?;
        Ok(source)
    }
}

/// With no explicit index, the file matching this episode's SxxEyy among
/// the torrent's files (for a season pack Core already manages).
fn episode_file_index(handle: &ManagedTorrentHandle, media_key: Option<&str>) -> Option<usize> {
    let pattern = regex::Regex::new(&episode_file_regex(media_key)?).ok()?;
    handle
        .with_metadata(|metadata| {
            metadata
                .file_infos
                .iter()
                .enumerate()
                .filter(|(_, file)| pattern.is_match(&file.relative_filename.to_string_lossy()))
                .max_by_key(|(_, file)| file.len)
                .map(|(index, _)| index)
        })
        .ok()
        .flatten()
}

fn pick_file(
    handle: &ManagedTorrentHandle,
    wanted: Option<usize>,
) -> Result<(usize, PathBuf, u64), Failure> {
    let selected: Option<HashSet<usize>> = handle.only_files().map(|files| files.into_iter().collect());
    handle
        .with_metadata(|metadata| {
            let files = &metadata.file_infos;
            if let Some(index) = wanted {
                return files
                    .get(index)
                    .map(|file| (index, file.relative_filename.clone(), file.len));
            }
            files
                .iter()
                .enumerate()
                .filter(|(index, _)| selected.as_ref().is_none_or(|set| set.contains(index)))
                .max_by_key(|(_, file)| file.len)
                .map(|(index, file)| (index, file.relative_filename.clone(), file.len))
        })
        .map_err(|error| Failure::new("internal", format!("{error:#}")))?
        .ok_or_else(|| Failure::new("no_file", "The source does not contain the requested file."))
}

/// Direct play needs a container and codecs every browser decodes. HEVC
/// always goes through the remux: sources often carry the `hev1` tag, which
/// browsers refuse, and the remux rewrites it to `hvc1`.
fn choose_mode(probe: &MediaProbe, file_name: &str, hevc_capable: bool) -> Result<Mode, Failure> {
    let name = file_name.to_ascii_lowercase();
    let format = probe.format_name.as_deref().unwrap_or("");
    let is_mp4 = format.contains("mp4") || format.contains("mov");
    let is_webm = name.ends_with(".webm");
    let video = probe.video_codec.as_deref().unwrap_or("");
    let audio = probe.audio_codec.as_deref();
    let direct_video = match video {
        "h264" => is_mp4,
        "vp8" | "vp9" | "av1" => is_webm,
        _ => false,
    };
    let direct_audio = matches!(audio, None | Some("aac" | "mp3" | "opus" | "vorbis"));
    if direct_video && direct_audio {
        return Ok(Mode::Direct);
    }
    match video {
        "h264" => Ok(Mode::Hls),
        "hevc" if hevc_capable => Ok(Mode::Hls),
        "hevc" => Err(Failure::new("unsupported", "This browser cannot play HEVC video.")),
        "" => Err(Failure::new("unsupported", "The source has no video.")),
        other => Err(Failure::new(
            "unsupported",
            format!("Video codec {other} cannot play in the browser."),
        )),
    }
}

/// Builds the segment layout and the source time that becomes playlist zero.
fn plan_for(index: Option<&MkvIndex>, duration: f64) -> (SegmentPlan, f64) {
    match index {
        Some(index) if index.keyframes.len() >= 2 => {
            let first = index.keyframes[0];
            // Sources cut from broadcasts can begin at a large timestamp.
            let origin = if first > 0.5 { first } else { 0.0 };
            let keyframes: Vec<f64> = index.keyframes.iter().map(|time| time - origin).collect();
            (SegmentPlan::from_keyframes(&keyframes, duration - origin), origin)
        }
        _ => (SegmentPlan::grid(duration), 0.0),
    }
}

/// `tv:236235:2:1` → filename regex for S02E01 / 2x01. Movies and
/// incomplete keys (`tv:123:-:-`) produce nothing.
pub fn episode_file_regex(media_key: Option<&str>) -> Option<String> {
    let key = media_key?;
    let mut parts = key.split(':');
    let kind = parts.next()?;
    if !kind.eq_ignore_ascii_case("tv") {
        return None;
    }
    let _id = parts.next()?;
    let season: u32 = parts.next()?.parse().ok()?;
    let episode: u32 = parts.next()?.parse().ok()?;
    if season == 0 || episode == 0 {
        return None;
    }
    Some(format!(
        r"(?i)(?:s0*{season}[ ._\-]?e0*{episode}|{season}x0*{episode})(?:\D|$)"
    ))
}

/// Ranged reads through rqbit's stream endpoint (which prioritizes the
/// requested pieces on a cold torrent).
struct HttpSource {
    client: reqwest::Client,
    url: String,
    len: u64,
}

impl ByteSource for HttpSource {
    fn len(&self) -> u64 {
        self.len
    }

    async fn read_at(&self, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        if length == 0 {
            return Ok(Vec::new());
        }
        let end = (offset + length).min(self.len) - 1;
        let response = self
            .client
            .get(&self.url)
            .header(reqwest::header::RANGE, format!("bytes={offset}-{end}"))
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("source read failed ({})", response.status()));
        }
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        Ok(bytes.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(video: &str, audio: &str, format: &str) -> MediaProbe {
        MediaProbe {
            video_codec: Some(video.into()),
            audio_codec: Some(audio.into()),
            audio_stream_index: Some(1),
            duration_seconds: Some(100.0),
            format_name: Some(format.into()),
            chapters: vec![],
        }
    }

    #[test]
    fn mp4_with_browser_codecs_plays_directly() {
        let mode = choose_mode(&probe("h264", "aac", "mov,mp4,m4a,3gp,3g2,mj2"), "a.mp4", false).unwrap();
        assert_eq!(mode, Mode::Direct);
    }

    #[test]
    fn mp4_with_dolby_audio_is_remuxed() {
        let mode = choose_mode(&probe("h264", "eac3", "mov,mp4,m4a,3gp,3g2,mj2"), "a.mp4", false).unwrap();
        assert_eq!(mode, Mode::Hls);
    }

    #[test]
    fn hevc_needs_browser_support() {
        assert_eq!(choose_mode(&probe("hevc", "aac", "matroska,webm"), "a.mkv", true).unwrap(), Mode::Hls);
        assert!(choose_mode(&probe("hevc", "aac", "matroska,webm"), "a.mkv", false).is_err());
        assert!(choose_mode(&probe("av1", "aac", "matroska,webm"), "a.mkv", true).is_err());
    }

    #[test]
    fn late_starting_sources_are_rebased() {
        let index = MkvIndex {
            duration_seconds: Some(100.0),
            video_codec_id: None,
            keyframes: vec![10.0, 16.0, 22.5, 30.0],
        };
        let (plan, origin) = plan_for(Some(&index), 110.0);
        assert_eq!(origin, 10.0);
        assert_eq!(plan.start(1), 6.0);
    }
}
