//! Cubo's ffmpeg remux pipeline: turns MKV / incompatible-audio torrent
//! streams into a growing fMP4 HLS playlist the browser can play.
//!
//! This module is part of the verified-working playback pipeline described in
//! AGENTS.md — its flags and structure encode fixes for real A/V sync,
//! seeking, and warm-up bugs. Read the invariants there before changing:
//! notably `-noaccurate_seek` on seeks (lip-sync), the per-job nonce (browser
//! cache splicing), the tight probe caps + prewarm (startup latency), and the
//! one-active-job eviction model.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const PLAYLIST_NAME: &str = "media.m3u8";
const PLAYLIST_WAIT: Duration = Duration::from_secs(90);
const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

/// Codecs the remux path can pass through with `-c:v copy`. HEVC remuxes to
/// fMP4 with an `hvc1` tag; the client only routes HEVC here after detecting
/// decode support, so anything else (AV1, …) is still refused and the client
/// falls to the next source.
const COPYABLE_VIDEO: [&str; 2] = ["h264", "hevc"];
/// Audio codecs browsers decode natively; everything else becomes AAC.
const COPYABLE_AUDIO: [&str; 3] = ["aac", "mp3", "opus"];

#[derive(Debug, Clone)]
pub struct MediaProbe {
    pub video_codec: Option<String>,
    /// Codec of the audio stream the remux will actually use.
    pub audio_codec: Option<String>,
    /// Absolute index of the chosen audio stream, for `-map 0:N`. Releases
    /// with several audio tracks often list a dub first, so the remux must
    /// never blindly take `0:a:0`.
    pub audio_stream_index: Option<u32>,
    pub duration_seconds: Option<f64>,
}

impl MediaProbe {
    pub fn video_copyable(&self) -> bool {
        self.video_codec
            .as_deref()
            .is_some_and(|codec| COPYABLE_VIDEO.contains(&codec))
    }

    fn audio_copyable(&self) -> bool {
        match self.audio_codec.as_deref() {
            None => true,
            Some(codec) => COPYABLE_AUDIO.contains(&codec),
        }
    }
}

#[derive(Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    #[serde(default)]
    format: FfprobeFormat,
}

#[derive(Default, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

#[derive(Deserialize)]
struct FfprobeStream {
    index: Option<u32>,
    codec_type: Option<String>,
    codec_name: Option<String>,
    #[serde(default)]
    tags: FfprobeTags,
    #[serde(default)]
    disposition: FfprobeDisposition,
}

#[derive(Default, Deserialize)]
struct FfprobeTags {
    language: Option<String>,
}

#[derive(Default, Deserialize)]
struct FfprobeDisposition {
    default: Option<u8>,
}

/// Picks the audio track the viewer most likely wants: English first, then
/// whatever the container marks as default, then the first audio stream.
fn pick_audio_stream(streams: &[FfprobeStream]) -> Option<&FfprobeStream> {
    let is_audio = |stream: &&FfprobeStream| stream.codec_type.as_deref() == Some("audio");
    let is_english = |stream: &&FfprobeStream| {
        matches!(
            stream.tags.language.as_deref().map(str::to_ascii_lowercase).as_deref(),
            Some("eng" | "en" | "english")
        )
    };
    streams
        .iter()
        .filter(is_audio)
        .find(is_english)
        .or_else(|| {
            streams
                .iter()
                .filter(is_audio)
                .find(|stream| stream.disposition.default == Some(1))
        })
        .or_else(|| streams.iter().find(is_audio))
}

struct ActiveJob {
    key: String,
    dir: PathBuf,
    /// Seconds into the source this job's ffmpeg was started at (`-ss`).
    start_seconds: f64,
    /// Unique per job. Appended to segment URLs so a browser can never splice
    /// cached segments from a previous job (same names, different offset)
    /// into this one — that mismatch played audio from one scene over video
    /// from another.
    nonce: String,
    probe: MediaProbe,
    child: Child,
}

/// Runs the ffmpeg remux helper: turns MKV / incompatible-audio sources into
/// a growing fMP4 HLS playlist the browser can play. One job at a time — a new
/// title evicts the previous job and its segments.
pub struct TranscodeManager {
    ffmpeg: Option<PathBuf>,
    ffprobe: Option<PathBuf>,
    dir: PathBuf,
    active: Mutex<Option<ActiveJob>>,
    /// Probe results warmed in the background while a torrent buffers, so the
    /// first playlist request doesn't pay for ffprobe serially.
    probes: Mutex<HashMap<String, MediaProbe>>,
    prewarming: Mutex<HashSet<String>>,
}

impl TranscodeManager {
    pub fn new(dir: PathBuf) -> Self {
        // Leftover segments from a previous run are useless without their job.
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        Self {
            ffmpeg: find_tool("ffmpeg"),
            ffprobe: find_tool("ffprobe"),
            dir,
            active: Mutex::new(None),
            probes: Mutex::new(HashMap::new()),
            prewarming: Mutex::new(HashSet::new()),
        }
    }

    pub fn available(&self) -> bool {
        self.ffmpeg.is_some() && self.ffprobe.is_some()
    }

    pub async fn probe(&self, input_url: &str) -> Result<MediaProbe, String> {
        let ffprobe = self.ffprobe.as_ref().ok_or("ffprobe is not available")?;
        let output = tokio::time::timeout(
            PROBE_TIMEOUT,
            Command::new(ffprobe)
                .args([
                    "-v",
                    "error",
                    "-print_format",
                    "json",
                    "-show_streams",
                    "-show_format",
                    // Stream info for MKV lives in the header; a 20M budget
                    // made cold starts wait on megabytes of torrent data that
                    // add nothing. These caps bound the worst case tightly.
                    "-analyzeduration",
                    "10M",
                    "-probesize",
                    "5M",
                ])
                .arg(input_url)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output(),
        )
        .await
        .map_err(|_| "probing the source timed out".to_string())?
        .map_err(|error| format!("could not run ffprobe: {error}"))?;

        if !output.status.success() {
            return Err("ffprobe could not read the source".into());
        }
        let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("unexpected ffprobe output: {error}"))?;

        let video_codec = parsed
            .streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some("video"))
            .and_then(|stream| stream.codec_name.clone());
        let audio = pick_audio_stream(&parsed.streams);
        Ok(MediaProbe {
            video_codec,
            audio_codec: audio.and_then(|stream| stream.codec_name.clone()),
            audio_stream_index: audio.and_then(|stream| stream.index),
            duration_seconds: parsed
                .format
                .duration
                .as_deref()
                .and_then(|duration| duration.parse::<f64>().ok())
                .filter(|duration| duration.is_finite() && *duration > 0.0),
        })
    }

    /// Starts (or reuses) the remux job for `key` at `start_seconds`,
    /// returning its directory. A different start offset restarts ffmpeg with
    /// an input seek (`-ss`), which is how seeking into unconverted regions
    /// works: the new playlist's time zero equals `start_seconds`.
    pub async fn ensure_job(
        &self,
        key: &str,
        input_url: &str,
        probe: &MediaProbe,
        start_seconds: f64,
    ) -> Result<PathBuf, String> {
        let ffmpeg = self.ffmpeg.as_ref().ok_or("ffmpeg is not available")?;
        let mut active = self.active.lock().await;

        if let Some(job) = active.as_mut() {
            if job.key == key && same_start(job.start_seconds, start_seconds) {
                // A finished ffmpeg with a playlist on disk is still a valid
                // job; only restart when it died before producing anything.
                let finished = matches!(job.child.try_wait(), Ok(Some(_)));
                if !finished || job.dir.join(PLAYLIST_NAME).exists() {
                    return Ok(job.dir.clone());
                }
            }
            let mut previous = active.take().expect("checked above");
            let _ = previous.child.kill().await;
            let _ = tokio::fs::remove_dir_all(&previous.dir).await;
        }

        let job_dir = self.dir.join(sanitize_key(key));
        let _ = tokio::fs::remove_dir_all(&job_dir).await;
        tokio::fs::create_dir_all(&job_dir)
            .await
            .map_err(|error| format!("could not create transcode directory: {error}"))?;

        let mut command = Command::new(ffmpeg);
        command
            .current_dir(&job_dir)
            .args(["-nostdin", "-v", "error"])
            // ffmpeg re-reads bytes rqbit already cached for ffprobe, but a
            // smaller analysis budget still shaves startup on cold torrents.
            .args(["-analyzeduration", "10M", "-probesize", "5M"]);
        if start_seconds > 0.1 {
            // Input seek: ffmpeg range-requests the container index and lands
            // on the keyframe at/before the target, so output timestamps
            // restart at zero — the client adds the offset back.
            //
            // -noaccurate_seek is load-bearing for A/V sync: without it,
            // accurate seeking trims the decoded (transcoded audio) stream to
            // the exact target while copied video still starts at the earlier
            // keyframe. That leading video-only gap made players shift audio
            // to close it — a constant lip-sync error on every resume/seek.
            // With it, both streams start together at the keyframe.
            command.args(["-noaccurate_seek", "-ss", &format!("{start_seconds:.3}")]);
        }
        command
            .args(["-i", input_url])
            .args(["-map", "0:v:0"]);
        match probe.audio_stream_index {
            Some(index) => command.args(["-map", &format!("0:{index}")]),
            None => command.args(["-map", "0:a:0?"]),
        };
        command.args(["-c:v", "copy"]);
        if probe.video_codec.as_deref() == Some("hevc") {
            // Safari, WKWebView and MSE only accept HEVC in MP4 when it
            // carries the hvc1 tag (ffmpeg writes hev1 by default).
            command.args(["-tag:v", "hvc1"]);
        }
        if probe.audio_copyable() {
            command.args(["-c:a", "copy"]);
        } else {
            command.args(["-c:a", "aac", "-ac", "2", "-b:a", "192k"]);
        }
        command
            .args(["-sn", "-dn"])
            .args(["-f", "hls"])
            // Short first segments so the playlist is playable in ~2s of
            // media instead of 6 (copy mode still cuts on keyframes, so the
            // real first cut lands on the first keyframe past 2s).
            .args(["-hls_init_time", "2"])
            .args(["-hls_time", "6"])
            .args(["-hls_list_size", "0"])
            .args(["-hls_playlist_type", "event"])
            .args(["-hls_segment_type", "fmp4"])
            .args(["-hls_fmp4_init_filename", "init.mp4"])
            .args(["-hls_flags", "independent_segments"])
            .arg(PLAYLIST_NAME)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);

        let child = command
            .spawn()
            .map_err(|error| format!("could not start ffmpeg: {error}"))?;
        *active = Some(ActiveJob {
            key: key.to_owned(),
            dir: job_dir.clone(),
            start_seconds,
            nonce: uuid::Uuid::new_v4().simple().to_string(),
            probe: probe.clone(),
            child,
        });
        Ok(job_dir)
    }

    /// Cache-busting id of the current job for `key`.
    pub async fn job_nonce(&self, key: &str) -> Option<String> {
        let active = self.active.lock().await;
        active
            .as_ref()
            .filter(|job| job.key == key)
            .map(|job| job.nonce.clone())
    }

    /// Directory of the current job for `key`, when one exists.
    pub async fn job_dir(&self, key: &str) -> Option<PathBuf> {
        let active = self.active.lock().await;
        active
            .as_ref()
            .filter(|job| job.key == key)
            .map(|job| job.dir.clone())
    }

    /// Source duration recorded when the job for `key` was started.
    pub async fn job_duration(&self, key: &str) -> Option<f64> {
        let active = self.active.lock().await;
        active
            .as_ref()
            .filter(|job| job.key == key)
            .and_then(|job| job.probe.duration_seconds)
    }

    /// Probe captured when the current job for `key` started (seek restarts)
    /// or warmed in the background while the torrent buffered — either way a
    /// hit skips a fresh, serial ffprobe.
    pub async fn cached_probe(&self, key: &str) -> Option<MediaProbe> {
        {
            let active = self.active.lock().await;
            if let Some(probe) = active
                .as_ref()
                .filter(|job| job.key == key)
                .map(|job| job.probe.clone())
            {
                return Some(probe);
            }
        }
        self.probes.lock().await.get(key).cloned()
    }

    /// Stores a probe for later playlist requests.
    pub async fn remember_probe(&self, key: &str, probe: MediaProbe) {
        let mut probes = self.probes.lock().await;
        // A handful of entries covers previews plus the active title; the
        // cache never needs to grow beyond that.
        if probes.len() >= 16 {
            probes.clear();
        }
        probes.insert(key.to_owned(), probe);
    }

    /// Probes `input_url` in the background while the torrent is still
    /// buffering, retrying briefly while the stream endpoint warms up. By the
    /// time the client asks for the playlist the result is usually cached.
    pub async fn prewarm(&self, key: String, input_url: String) {
        if !self.available() {
            return;
        }
        {
            if self.probes.lock().await.contains_key(&key) {
                return;
            }
            let mut prewarming = self.prewarming.lock().await;
            if !prewarming.insert(key.clone()) {
                return;
            }
        }

        for attempt in 0..5 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            if let Ok(probe) = self.probe(&input_url).await {
                self.remember_probe(&key, probe).await;
                break;
            }
        }
        self.prewarming.lock().await.remove(&key);
    }

    /// True when the job for `key` at `start_seconds` is alive or already
    /// left a playlist on disk — i.e. its playlist can be served without
    /// probing the source again. Playlist polls hit this path every few
    /// seconds.
    pub async fn job_usable(&self, key: &str, start_seconds: f64) -> bool {
        let mut active = self.active.lock().await;
        let Some(job) = active.as_mut() else { return false };
        if job.key != key || !same_start(job.start_seconds, start_seconds) {
            return false;
        }
        let finished = matches!(job.child.try_wait(), Ok(Some(_)));
        !finished || job.dir.join(PLAYLIST_NAME).exists()
    }

    /// Waits until ffmpeg has written a playlist with at least one segment.
    pub async fn wait_for_playlist(&self, job_dir: &Path) -> Result<(), String> {
        let playlist = job_dir.join(PLAYLIST_NAME);
        let deadline = tokio::time::Instant::now() + PLAYLIST_WAIT;
        loop {
            if let Ok(content) = tokio::fs::read_to_string(&playlist).await {
                if content.contains("#EXTINF") {
                    return Ok(());
                }
            }
            if tokio::time::Instant::now() > deadline {
                return Err("the converter took too long to produce playable video".into());
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
}

fn same_start(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.25
}

fn sanitize_key(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Locates a bundled or system ffmpeg tool. The directory next to the app
/// executable is checked first so a Tauri sidecar wins over system installs.
fn find_tool(name: &str) -> Option<PathBuf> {
    let file_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(&file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        candidates.push(Path::new(dir).join(&file_name));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(&file_name));
        }
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}
