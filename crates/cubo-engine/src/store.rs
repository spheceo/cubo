use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const DEFAULT_CACHE_BYTES: u64 = 25 * 1024 * 1024 * 1024;
const MAX_HISTORY_ITEMS: usize = 500;
/// Playback progress ticks arrive every few seconds; the state file is
/// rewritten at most this often, with a trailing flush for the final tick.
const PERSIST_MIN_INTERVAL_MS: u64 = 3_000;

#[derive(Clone)]
pub struct CoreStore {
    path: PathBuf,
    data: std::sync::Arc<Mutex<CoreData>>,
    /// Set when in-memory changes have not reached disk yet.
    dirty: std::sync::Arc<AtomicBool>,
    last_persist_ms: std::sync::Arc<AtomicU64>,
    flush_scheduled: std::sync::Arc<AtomicBool>,
    /// Serializes state-file writes so concurrent flushes cannot interleave.
    persist_lock: std::sync::Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub key: String,
    pub media_id: u64,
    pub media_type: String,
    pub imdb_id: Option<String>,
    pub title: String,
    pub subtitle: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    #[serde(default)]
    pub logo_path: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub progress: f64,
    pub completed: bool,
    pub last_watched_at: u64,
    pub watch_href: String,
    pub detail_href: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchLaterItem {
    pub key: String,
    pub media_id: u64,
    pub media_type: String,
    pub imdb_id: Option<String>,
    pub title: String,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub watch_href: String,
    pub detail_href: String,
    pub saved_at: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchAnalytics {
    pub total_watch_seconds: f64,
    pub play_sessions: u64,
    pub titles_started: u64,
    pub titles_completed: u64,
    pub last_watched_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachePreferences {
    pub max_bytes: u64,
    /// Absolute path of the torrent download folder. `None` means the
    /// process default (next to this state file, `downloads/`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
}

impl Default for CachePreferences {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_CACHE_BYTES,
            directory: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    pub torrent_id: Option<u64>,
    pub info_hash: String,
    pub media_key: Option<String>,
    pub title: Option<String>,
    /// Absolute paths of the downloaded files. The torrent engine forgets its
    /// torrents on restart, so deletion must be able to work straight against
    /// the filesystem.
    #[serde(default)]
    pub files: Vec<String>,
    pub last_accessed_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreData {
    #[serde(default = "state_version")]
    pub version: u32,
    #[serde(default)]
    pub history: Vec<LibraryItem>,
    #[serde(default)]
    pub watch_later: Vec<WatchLaterItem>,
    #[serde(default)]
    pub analytics: WatchAnalytics,
    #[serde(default)]
    pub cache: CachePreferences,
    #[serde(default)]
    pub cache_entries: Vec<CacheEntry>,
}

impl Default for CoreData {
    fn default() -> Self {
        Self {
            version: state_version(),
            history: Vec::new(),
            watch_later: Vec::new(),
            analytics: WatchAnalytics::default(),
            cache: CachePreferences::default(),
            cache_entries: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackUpdate {
    pub key: String,
    pub media_id: u64,
    pub media_type: String,
    pub imdb_id: Option<String>,
    pub title: String,
    pub subtitle: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    #[serde(default)]
    pub logo_path: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    #[serde(default)]
    pub watched_delta_seconds: f64,
    #[serde(default)]
    pub session_started: bool,
    pub watch_href: String,
    pub detail_href: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchLaterUpdate {
    pub saved: bool,
    pub item: WatchLaterItem,
}

impl CoreStore {
    pub async fn load(path: PathBuf) -> Result<Self, String> {
        let data = match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("invalid Cubo state file: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => CoreData::default(),
            Err(error) => return Err(format!("could not read Cubo state: {error}")),
        };

        Ok(Self {
            path,
            data: std::sync::Arc::new(Mutex::new(data)),
            dirty: std::sync::Arc::new(AtomicBool::new(false)),
            last_persist_ms: std::sync::Arc::new(AtomicU64::new(0)),
            flush_scheduled: std::sync::Arc::new(AtomicBool::new(false)),
            persist_lock: std::sync::Arc::new(Mutex::new(())),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn snapshot(&self) -> CoreData {
        self.data.lock().await.clone()
    }

    /// Progress ticks arrive every ~10 s during playback, so this stays
    /// lean: one pass over history and no snapshot in the response.
    pub async fn record_playback(&self, update: PlaybackUpdate) -> Result<(), String> {
        let mut data = self.data.lock().await;
        let now = now_millis();
        let progress = if update.duration_seconds > 0.0 {
            (update.position_seconds / update.duration_seconds).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let completed = progress >= 0.9;

        let item = LibraryItem {
            key: update.key.clone(),
            media_id: update.media_id,
            media_type: update.media_type,
            imdb_id: update.imdb_id,
            title: update.title,
            subtitle: update.subtitle,
            poster_path: update.poster_path,
            backdrop_path: update.backdrop_path,
            logo_path: update.logo_path,
            season: update.season,
            episode: update.episode,
            position_seconds: update.position_seconds.max(0.0),
            duration_seconds: update.duration_seconds.max(0.0),
            progress,
            completed,
            last_watched_at: now,
            watch_href: update.watch_href,
            detail_href: update.detail_href,
        };

        let existing = data
            .history
            .iter_mut()
            .find(|entry| entry.key == update.key);
        let new_title = existing.is_none();
        let was_completed = existing.as_ref().is_some_and(|entry| entry.completed);
        match existing {
            Some(entry) => *entry = item,
            None => data.history.push(item),
        }
        data.history
            .sort_by_key(|entry| std::cmp::Reverse(entry.last_watched_at));
        data.history.truncate(MAX_HISTORY_ITEMS);

        data.analytics.total_watch_seconds += update.watched_delta_seconds.clamp(0.0, 120.0);
        if update.session_started {
            data.analytics.play_sessions += 1;
        }
        if new_title {
            data.analytics.titles_started += 1;
        }
        if completed && !was_completed {
            data.analytics.titles_completed += 1;
        }
        data.analytics.last_watched_at = Some(now);

        drop(data);
        self.persist_throttled().await
    }

    pub async fn remove_history_item(&self, key: &str) -> Result<CoreData, String> {
        let mut data = self.data.lock().await;
        data.history.retain(|item| item.key != key);
        self.persist_locked(&data).await?;
        Ok(data.clone())
    }

    pub async fn update_watch_later(&self, update: WatchLaterUpdate) -> Result<CoreData, String> {
        let mut data = self.data.lock().await;
        data.watch_later.retain(|item| item.key != update.item.key);
        if update.saved {
            let mut item = update.item;
            item.saved_at = now_millis();
            data.watch_later.insert(0, item);
        }
        self.persist_locked(&data).await?;
        Ok(data.clone())
    }

    pub async fn update_cache_limit(&self, max_bytes: u64) -> Result<CoreData, String> {
        let mut data = self.data.lock().await;
        data.cache.max_bytes = max_bytes.clamp(1024 * 1024 * 1024, 1024 * 1024 * 1024 * 1024);
        self.persist_locked(&data).await?;
        Ok(data.clone())
    }

    pub async fn update_cache_directory(&self, directory: PathBuf) -> Result<CoreData, String> {
        let mut data = self.data.lock().await;
        data.cache.directory = Some(directory.to_string_lossy().into_owned());
        self.persist_locked(&data).await?;
        Ok(data.clone())
    }

    pub async fn touch_cache(
        &self,
        torrent_id: Option<u64>,
        info_hash: String,
        media_key: Option<String>,
        title: Option<String>,
        files: Vec<String>,
    ) -> Result<(), String> {
        let mut data = self.data.lock().await;
        let now = now_millis();
        if let Some(entry) = data
            .cache_entries
            .iter_mut()
            .find(|entry| entry.info_hash == info_hash)
        {
            entry.torrent_id = torrent_id.or(entry.torrent_id);
            entry.media_key = media_key.or_else(|| entry.media_key.clone());
            entry.title = title.or_else(|| entry.title.clone());
            if !files.is_empty() {
                entry.files = files;
            }
            entry.last_accessed_at = now;
        } else {
            data.cache_entries.push(CacheEntry {
                torrent_id,
                info_hash,
                media_key,
                title,
                files,
                last_accessed_at: now,
            });
        }
        self.persist_locked(&data).await
    }

    pub async fn remove_cache_entry(&self, id_or_hash: &str) -> Result<(), String> {
        let mut data = self.data.lock().await;
        data.cache_entries.retain(|entry| {
            entry.info_hash != id_or_hash
                && entry.torrent_id.map(|id| id.to_string()) != Some(id_or_hash.to_owned())
        });
        self.persist_locked(&data).await
    }

    pub async fn clear_cache_entries(&self) -> Result<(), String> {
        let mut data = self.data.lock().await;
        data.cache_entries.clear();
        self.persist_locked(&data).await
    }

    /// Persists at most once per [`PERSIST_MIN_INTERVAL_MS`]; ticks in between
    /// only mark the state dirty and schedule one trailing flush, so a burst
    /// of progress updates costs a single write.
    async fn persist_throttled(&self) -> Result<(), String> {
        let now = now_millis();
        let last = self.last_persist_ms.load(Ordering::Relaxed);
        if now.saturating_sub(last) >= PERSIST_MIN_INTERVAL_MS
            && self
                .last_persist_ms
                .compare_exchange(last, now, Ordering::AcqRel, Ordering::Relaxed)
                .is_ok()
        {
            return self.persist_now().await;
        }

        self.dirty.store(true, Ordering::Release);
        if self.flush_scheduled.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let store = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(PERSIST_MIN_INTERVAL_MS)).await;
            store.flush_scheduled.store(false, Ordering::Release);
            if !store.dirty.swap(false, Ordering::AcqRel) {
                return;
            }
            store.last_persist_ms.store(now_millis(), Ordering::Release);
            if let Err(error) = store.persist_now().await {
                eprintln!("Cubo could not save state: {error}");
            }
        });
        Ok(())
    }

    async fn persist_now(&self) -> Result<(), String> {
        let _guard = self.persist_lock.lock().await;
        let data = self.data.lock().await.clone();
        self.persist_locked(&data).await
    }

    async fn persist_locked(&self, data: &CoreData) -> Result<(), String> {
        let bytes = serde_json::to_vec(data)
            .map_err(|error| format!("could not encode Cubo state: {error}"))?;
        let temporary = self.path.with_extension("json.tmp");
        tokio::fs::write(&temporary, bytes)
            .await
            .map_err(|error| format!("could not write Cubo state: {error}"))?;
        tokio::fs::rename(&temporary, &self.path)
            .await
            .map_err(|error| format!("could not save Cubo state: {error}"))
    }
}

fn state_version() -> u32 {
    1
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
