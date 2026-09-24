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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Deserialize;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::remux_sink::RemuxSink;

const PLAYLIST_NAME: &str = "media.m3u8";
const PLAYLIST_WAIT: Duration = Duration::from_secs(90);
const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

/// A timeout is the only probe failure worth retrying: the swarm keeps
/// fetching while ffprobe stalls, so the second attempt lands on warm pieces.
enum ProbeError {
    TimedOut,
    Failed(String),
}

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
    /// ffprobe's container name list, e.g. `matroska,webm` or
    /// `mov,mp4,m4a,3gp,3g2,mj2`.
    pub format_name: Option<String>,
    /// Container chapters — named ones ("Intro", "Credits", "OP"/"ED") give
    /// exact, provider-independent skip windows.
    pub chapters: Vec<Chapter>,
}

#[derive(Debug, Clone)]
pub struct Chapter {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub title: String,
}

#[derive(Debug, Clone, Copy)]
pub struct SkipSegment {
    pub start: f64,
    pub end: f64,
}

/// A chapter (or crowd-sourced equivalent) with its section type, for the
/// player's dev timeline overlay.
#[derive(Debug, Clone)]
pub struct SkipSection {
    pub start: f64,
    pub end: f64,
    pub kind: &'static str,
    pub label: String,
}

/// Classifies one chapter title into a section kind. `chapter` is the
/// catch-all for real but generic markers ("Scene 2", "Chapter 4") — the
/// dev overlay still shows them so label coverage is visible at a glance.
fn chapter_kind(title: &str) -> &'static str {
    let title = title.trim().to_ascii_lowercase();
    let tagged = |prefix: &str| {
        title.starts_with(prefix)
            && title[prefix.len()..]
                .chars()
                .all(|ch| ch.is_ascii_digit() || ch.is_whitespace())
    };
    if title.contains("intro")
        || title.contains("opening")
        || tagged("op")
        || title.contains("title sequence")
        || title.contains("main title")
    {
        return "intro";
    }
    if title.contains("recap") || title.contains("previously") || title.contains("last time") {
        return "recap";
    }
    if title.contains("post credit")
        || title.contains("post-credit")
        || title.contains("postcredit")
        || title.contains("mid credit")
        || title.contains("mid-credit")
        || title.contains("after credit")
        || title.contains("stinger")
    {
        return "postcredits";
    }
    if title.contains("credits")
        || title.contains("ending")
        || tagged("ed")
        || title.contains("outro")
        || title.contains("closing")
    {
        return "credits";
    }
    if title.contains("preview")
        || title.contains("next time")
        || title.contains("coming up")
        || title.contains("next on")
    {
        return "preview";
    }
    "chapter"
}

/// Every chapter as a typed section, keeping the container's own labels.
/// Unlike `chapter_skip_segments` there are no position bounds — the dev
/// overlay should show what the file actually declares, mislabeled or not.
pub fn chapter_sections(chapters: &[Chapter]) -> Vec<SkipSection> {
    chapters
        .iter()
        .filter(|chapter| {
            chapter.start_seconds.is_finite()
                && chapter.end_seconds.is_finite()
                && chapter.end_seconds > chapter.start_seconds
        })
        .map(|chapter| SkipSection {
            start: chapter.start_seconds,
            end: chapter.end_seconds,
            kind: chapter_kind(&chapter.title),
            label: chapter.title.clone(),
        })
        .collect()
}

/// Maps named container chapters to skip windows. Returns (intro, credits).
/// Names are release-dependent, so anything unrecognized is ignored and the
/// API fallbacks in the skip-segments endpoint cover the gap. Sanity bounds
/// keep a mislabeled chapter from producing an absurd skip: an intro must sit
/// in the first half, credits must start past the 40% mark.
pub fn chapter_skip_segments(
    chapters: &[Chapter],
    duration_seconds: f64,
) -> (Option<SkipSegment>, Option<SkipSegment>) {
    let mut intro = None;
    let mut credits = None;
    for chapter in chapters {
        if !chapter.start_seconds.is_finite()
            || !chapter.end_seconds.is_finite()
            || chapter.end_seconds <= chapter.start_seconds
        {
            continue;
        }
        // The position bounds guard against a mislabeled mid-file chapter;
        // an unknown duration skips them — a chapter literally named "Intro"
        // is trustworthy on its own.
        match chapter_kind(&chapter.title) {
            "intro"
                if intro.is_none()
                    && (duration_seconds <= 0.0
                        || chapter.start_seconds < duration_seconds * 0.5) =>
            {
                intro = Some(SkipSegment {
                    start: chapter.start_seconds,
                    end: chapter.end_seconds,
                });
            }
            "credits"
                if credits.is_none()
                    && (duration_seconds <= 0.0
                        || chapter.start_seconds > duration_seconds * 0.4) =>
            {
                credits = Some(SkipSegment {
                    start: chapter.start_seconds,
                    end: chapter.end_seconds,
                });
            }
            _ => {}
        }
    }
    (intro, credits)
}

impl MediaProbe {
    pub fn video_copyable(&self) -> bool {
        self.video_codec
            .as_deref()
            .is_some_and(|codec| COPYABLE_VIDEO.contains(&codec))
    }

    pub fn audio_copyable(&self) -> bool {
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
    #[serde(default)]
    chapters: Vec<FfprobeChapter>,
}

#[derive(Deserialize)]
struct FfprobeChapter {
    start_time: Option<String>,
    end_time: Option<String>,
    #[serde(default)]
    tags: FfprobeChapterTags,
}

#[derive(Default, Deserialize)]
struct FfprobeChapterTags {
    title: Option<String>,
}

#[derive(Default, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
    format_name: Option<String>,
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
            stream
                .tags
                .language
                .as_deref()
                .map(str::to_ascii_lowercase)
                .as_deref(),
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
    /// Where ffmpeg ACTUALLY landed: the keyframe at/before `start_seconds`.
    /// Input seeks are keyframe-aligned, so this can be a few seconds earlier
    /// than the requested start — playlist time zero is THIS value, and the
    /// client must use it (not the request) as its absolute-time offset.
    actual_start_seconds: f64,
    /// Unique per job. Appended to segment URLs so a browser can never splice
    /// cached segments from a previous job (same names, different offset)
    /// into this one — that mismatch played audio from one scene over video
    /// from another.
    nonce: String,
    /// Client-issued seek id. hls.js keeps polling the playlist URL it was
    /// given — including the previous `start=` — and a lower generation is a
    /// leftover poll that must not kill a newer remux.
    generation: u64,
    probe: MediaProbe,
    child: Child,
    /// Last playlist that contained at least one segment. ffmpeg rewrites
    /// `media.m3u8` in place; a mid-write read should serve this instead of
    /// 404ing — hls.js treats a missing EVENT playlist as a live restart.
    last_playlist: Option<String>,
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
    /// Invalidates background probe tasks when cache contents are cleared.
    cache_epoch: AtomicU64,
    cache_changed: tokio::sync::watch::Sender<u64>,
    cache_blocked: std::sync::atomic::AtomicBool,
    remux_sink: RemuxSink,
    sink_endpoint: Mutex<Option<String>>,
}

impl TranscodeManager {
    pub fn new(dir: PathBuf) -> Self {
        // Leftover segments from a previous run are useless without their job.
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        Self {
            ffmpeg: find_tool("ffmpeg"),
            ffprobe: find_tool("ffprobe"),
            dir: dir.clone(),
            active: Mutex::new(None),
            probes: Mutex::new(HashMap::new()),
            prewarming: Mutex::new(HashSet::new()),
            cache_epoch: AtomicU64::new(0),
            cache_changed: tokio::sync::watch::channel(0).0,
            cache_blocked: std::sync::atomic::AtomicBool::new(false),
            remux_sink: RemuxSink::new(dir.clone(), 1024 * 1024 * 1024),
            sink_endpoint: Mutex::new(None),
        }
    }

    /// Configure the hard byte budget reserved for rolling remux output.
    pub async fn set_budget(&self, bytes: u64) -> Result<(), String> {
        self.remux_sink.set_budget(bytes).await
    }

    /// Start the sink namespace for a job. The bridge should use the job's
    /// unguessable nonce as the HTTP PUT path component.
    pub async fn begin_sink_job(&self, job: &str, actual_start: f64) -> Result<PathBuf, String> {
        self.remux_sink.begin_job(job, actual_start).await
    }

    pub fn remux_sink(&self) -> RemuxSink {
        self.remux_sink.clone()
    }

    pub async fn listen_sink(&self) -> Result<String, String> {
        let mut endpoint = self.sink_endpoint.lock().await;
        if let Some(endpoint) = endpoint.as_ref() {
            return Ok(endpoint.clone());
        }
        let address = self.remux_sink.listen().await?;
        *endpoint = Some(address.clone());
        Ok(address)
    }

    /// Returns the private HTTP PUT destinations ffmpeg should use for the
    /// playlist and numbered fMP4 segments of the active source.
    pub async fn sink_output_urls(&self, key: &str) -> Result<(String, String), String> {
        let job = self.active_sink_job(key).await?;
        let playlist = self
            .remux_sink
            .put_url(&job, "media.m3u8")
            .await
            .ok_or("remux sink is not listening")?;
        let segments = self
            .remux_sink
            .put_url(&job, "segment%05d.m4s")
            .await
            .ok_or("remux sink is not listening")?;
        Ok((playlist, segments))
    }

    pub async fn read_sink_file(&self, key: &str, file: &str) -> Result<Vec<u8>, String> {
        let job = self.active_sink_job(key).await?;
        self.remux_sink.read(&job, file).await
    }

    /// Resolve the private sink namespace for the currently active source.
    /// The bridge uses this to authorize HTTP PUTs without exposing arbitrary
    /// filesystem paths or accepting a caller-supplied job id.
    async fn active_sink_job(&self, key: &str) -> Result<String, String> {
        let active = self.active.lock().await;
        let job = active
            .as_ref()
            .filter(|job| job.key == key)
            .ok_or("no active remux job")?;
        Ok(job.nonce.clone())
    }

    pub async fn put_sink_file(&self, key: &str, file: &str, bytes: &[u8]) -> Result<(), String> {
        let job = self.active_sink_job(key).await?;
        self.remux_sink.put(&job, file, bytes).await
    }

    pub async fn note_sink_playlist(&self, key: &str, playlist: &str) -> Result<(), String> {
        let job = self.active_sink_job(key).await?;
        self.remux_sink.note_playlist(&job, playlist).await
    }

    /// Advance the absolute playback watermark for the active sink job.
    pub async fn set_playhead(&self, key: &str, absolute_seconds: f64) -> Result<(), String> {
        let job = self.active_sink_job(key).await?;
        self.remux_sink.set_playhead(&job, absolute_seconds).await
    }

    pub async fn retained_start(&self, key: &str) -> Option<f64> {
        let job = self
            .active
            .lock()
            .await
            .as_ref()
            .filter(|job| job.key == key)
            .map(|job| job.nonce.clone())?;
        self.remux_sink.retained_start(&job).await
    }

    pub async fn report_segment_served(&self, key: &str, file: &str) -> Result<(), String> {
        let job = self.active_sink_job(key).await?;
        self.remux_sink.report_segment_served(&job, file).await
    }

    pub fn ffmpeg_path(&self) -> Option<&Path> {
        self.ffmpeg.as_deref()
    }

    pub fn available(&self) -> bool {
        self.ffmpeg.is_some() && self.ffprobe.is_some()
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn cache_blocked(&self) -> bool {
        self.cache_blocked.load(Ordering::Acquire)
    }

    pub async fn probe(&self, input_url: &str) -> Result<MediaProbe, String> {
        let ffprobe = self.ffprobe.as_ref().ok_or("ffprobe is not available")?;
        // A cold torrent can legitimately need more than one timeout window:
        // the killed attempt already pulled the header pieces into the cache,
        // so an immediate retry usually finishes fast.
        match self.probe_once(ffprobe, input_url).await {
            Err(ProbeError::TimedOut) => {
                tracing::info!(target: "probe", "source probe timed out; retrying once");
                self.probe_once(ffprobe, input_url).await
            }
            result => result,
        }
        .map_err(|error| match error {
            ProbeError::TimedOut => "probing the source timed out".to_string(),
            ProbeError::Failed(error) => error,
        })
    }

    async fn probe_once(
        &self,
        ffprobe: &Path,
        input_url: &str,
    ) -> Result<MediaProbe, ProbeError> {
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
                    "-show_chapters",
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
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| ProbeError::TimedOut)?
        .map_err(|error| ProbeError::Failed(format!("could not run ffprobe: {error}")))?;

        if !output.status.success() {
            return Err(ProbeError::Failed("ffprobe could not read the source".into()));
        }
        let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout).map_err(|error| {
            ProbeError::Failed(format!("unexpected ffprobe output: {error}"))
        })?;

        let video_codec = parsed
            .streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some("video"))
            .and_then(|stream| stream.codec_name.clone());
        let audio = pick_audio_stream(&parsed.streams);
        let duration_seconds = parsed
            .format
            .duration
            .as_deref()
            .and_then(|duration| duration.parse::<f64>().ok())
            .filter(|duration| duration.is_finite() && *duration > 0.0);
        tracing::info!(
            target: "probe",
            video_codec = video_codec.as_deref().unwrap_or("-"),
            audio_codec = audio.and_then(|stream| stream.codec_name.clone()).as_deref().unwrap_or("-"),
            audio_stream_index = audio.and_then(|stream| stream.index).unwrap_or(u32::MAX),
            duration_seconds = duration_seconds.unwrap_or(0.0),
            "source probe complete"
        );
        let chapters = parsed
            .chapters
            .iter()
            .filter_map(|chapter| {
                Some(Chapter {
                    start_seconds: chapter.start_time.as_deref()?.parse().ok()?,
                    end_seconds: chapter.end_time.as_deref()?.parse().ok()?,
                    title: chapter.tags.title.clone().unwrap_or_default(),
                })
            })
            .collect();
        Ok(MediaProbe {
            video_codec,
            audio_codec: audio.and_then(|stream| stream.codec_name.clone()),
            audio_stream_index: audio.and_then(|stream| stream.index),
            duration_seconds,
            format_name: parsed.format.format_name.clone(),
            chapters,
        })
    }

    /// Starts (or reuses) the remux job for `key` at `start_seconds`,
    /// returning its directory. A different start offset restarts ffmpeg with
    /// an input seek (`-ss`), which is how seeking into unconverted regions
    /// works: the new playlist's time zero equals `start_seconds`.
    ///
    /// `generation` is the client's seek id (`0` = old client, no id). A
    /// request from an older generation never evicts a newer job — that is
    /// how leftover hls.js polls of the previous playlist URL are ignored.
    pub async fn ensure_job(
        &self,
        key: &str,
        input_url: &str,
        probe: &MediaProbe,
        start_seconds: f64,
        generation: u64,
    ) -> Result<PathBuf, String> {
        let ffmpeg = self.ffmpeg.as_ref().ok_or("ffmpeg is not available")?;
        // Tests and embedded callers may construct a manager without the
        // engine startup hook. The sink listener is loopback-only and its
        // listen operation is idempotent.
        let _ = self.listen_sink().await?;
        let mut active = self.active.lock().await;

        if let Some(job) = active.as_mut() {
            if job_covers_request(
                &job.key,
                job.start_seconds,
                job.generation,
                key,
                start_seconds,
                nonzero_generation(generation),
            ) {
                // A finished ffmpeg with a playlist on disk is still a valid
                // job; only restart when it died before producing anything.
                let finished = matches!(job.child.try_wait(), Ok(Some(_)));
                if !finished || job.dir.join(PLAYLIST_NAME).exists() {
                    job.generation = job.generation.max(generation);
                    return Ok(job.dir.clone());
                }
            }
        }

        // Torrent range reads can stall. Keep playlist/segment metadata and
        // newer seeks accessible while measuring this request's landing point.
        drop(active);
        let actual_start = if start_seconds > 0.1 {
            let ffprobe = self.ffprobe.as_ref().ok_or("ffprobe is not available")?;
            find_keyframe_before(ffprobe, input_url, start_seconds).await
        } else {
            Ok(start_seconds)
        };

        // Another request may have installed a job while this scan ran.
        // In particular, a stale scan must never evict a newer generation.
        let mut active = self.active.lock().await;
        if let Some(job) = active.as_mut() {
            if job_covers_request(
                &job.key,
                job.start_seconds,
                job.generation,
                key,
                start_seconds,
                nonzero_generation(generation),
            ) {
                let finished = matches!(job.child.try_wait(), Ok(Some(_)));
                if !finished || job.dir.join(PLAYLIST_NAME).exists() {
                    job.generation = job.generation.max(generation);
                    return Ok(job.dir.clone());
                }
            }
        }

        // Even a failed/expired stale scan should reuse the newer job above.
        // A current request must have a measured landing before replacing it.
        let actual_start = actual_start?;

        if let Some(mut previous) = active.take() {
            let _ = previous.child.kill().await;
            let _ = tokio::fs::remove_dir_all(&previous.dir).await;
            let _ = self.remux_sink.remove_job(&previous.nonce).await;
        }

        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let job_dir = self.remux_sink.begin_job(&nonce, actual_start).await?;
        let playlist_url = self
            .remux_sink
            .put_url(&nonce, "media.m3u8")
            .await
            .ok_or("remux sink is not listening")?;
        let segment_url = self
            .remux_sink
            .put_url(&nonce, "segment%05d.m4s")
            .await
            .ok_or("remux sink is not listening")?;

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
        command.args(["-i", input_url]).args(["-map", "0:v:0"]);
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
            .args(["-hls_segment_filename", &segment_url])
            .args(["-hls_flags", "independent_segments"])
            .args(["-method", "PUT"])
            .args(["-http_persistent", "0"])
            .arg(playlist_url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(if cfg!(test) {
                Stdio::inherit()
            } else {
                Stdio::null()
            })
            .kill_on_drop(true);

        let failed_nonce = nonce.clone();
        let child = command.spawn().map_err(|error| {
            let sink = self.remux_sink.clone();
            // The child has not started, so no PUT can race this cleanup.
            tokio::spawn(async move {
                let _ = sink.remove_job(&failed_nonce).await;
            });
            format!("could not start ffmpeg: {error}")
        })?;
        tracing::info!(
            target: "remux",
            key = %key,
            requested_start_seconds = start_seconds,
            actual_start_seconds = actual_start,
            "remux job started"
        );
        *active = Some(ActiveJob {
            key: key.to_owned(),
            dir: job_dir.clone(),
            start_seconds,
            actual_start_seconds: actual_start,
            nonce,
            generation,
            probe: probe.clone(),
            child,
            last_playlist: None,
        });
        Ok(job_dir)
    }

    /// Where the current job for `key` actually begins in the source (the
    /// seek keyframe), which can differ from the requested `-ss` target.
    pub async fn job_actual_start(&self, key: &str) -> Option<f64> {
        let active = self.active.lock().await;
        active
            .as_ref()
            .filter(|job| job.key == key)
            .map(|job| job.actual_start_seconds)
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

    pub async fn remember_playlist(&self, key: &str, content: String) {
        let mut active = self.active.lock().await;
        if let Some(job) = active.as_mut().filter(|job| job.key == key) {
            job.last_playlist = Some(content);
        }
    }

    pub async fn last_playlist(&self, key: &str) -> Option<String> {
        let active = self.active.lock().await;
        active
            .as_ref()
            .filter(|job| job.key == key)
            .and_then(|job| job.last_playlist.clone())
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

    /// True while a prewarm probe is running for `key` — callers that would
    /// otherwise start a second ffprobe on the same cold file can wait a
    /// moment and take the warmed result instead.
    pub async fn is_prewarming(&self, key: &str) -> bool {
        self.prewarming.lock().await.contains(key)
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
        if !self.available() || self.cache_blocked() {
            return;
        }
        let mut changed = self.cache_changed.subscribe();
        let epoch = self.cache_epoch.load(Ordering::Acquire);
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
            if self.cache_blocked() || self.cache_epoch.load(Ordering::Acquire) != epoch {
                return;
            }
            if attempt > 0 {
                tokio::select! {
                    _ = changed.changed() => return,
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                }
            }
            let result = tokio::select! {
                _ = changed.changed() => return,
                result = self.probe(&input_url) => result,
            };
            if let Ok(probe) = result {
                let mut probes = self.probes.lock().await;
                if self.cache_epoch.load(Ordering::Acquire) == epoch {
                    if probes.len() >= 16 {
                        probes.clear();
                    }
                    probes.insert(key.clone(), probe);
                }
                break;
            }
        }
        let mut prewarming = self.prewarming.lock().await;
        if self.cache_epoch.load(Ordering::Acquire) == epoch {
            prewarming.remove(&key);
        }
    }

    /// Stops ffmpeg and removes all remux output before an explicit cache
    /// clear. This prevents open files and late probe tasks from recreating
    /// cache data after the API reports success.
    pub async fn clear_cache(&self) -> Result<(), String> {
        self.cache_blocked.store(true, Ordering::Release);
        let epoch = self.cache_epoch.fetch_add(1, Ordering::AcqRel) + 1;
        self.cache_changed.send_replace(epoch);
        self.prewarming.lock().await.clear();
        self.probes.lock().await.clear();
        let mut active = self.active.lock().await;
        if let Some(job) = active.as_mut() {
            if job
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                job.child
                    .kill()
                    .await
                    .map_err(|error| format!("could not stop video conversion: {error}"))?;
            }
        }
        self.remux_sink.clear().await?;
        active.take();
        tokio::fs::remove_dir_all(&self.dir)
            .await
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(|error| format!("could not remove remux cache: {error}"))?;
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|error| format!("could not recreate remux directory: {error}"))
    }

    /// A new torrent request explicitly starts a new cache session after a
    /// user clear. Existing HLS polls remain blocked until then.
    pub fn begin_cache_session(&self) {
        self.cache_blocked.store(false, Ordering::Release);
    }

    /// Converted output belongs to its torrent and must be evicted with it.
    pub async fn remove_torrent_output(&self, id: &str, info_hash: &str) -> Result<(), String> {
        let mut active = self.active.lock().await;
        let Some(job) = active.as_mut() else {
            return Ok(());
        };
        let torrent = job.key.split(':').next().unwrap_or_default();
        if torrent != id && torrent != info_hash {
            return Ok(());
        }
        if job
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            job.child.kill().await.map_err(|error| error.to_string())?;
        }
        let nonce = job.nonce.clone();
        self.remux_sink.remove_job(&nonce).await?;
        active.take();
        Ok(())
    }

    /// True when the job for `key` can be served without probing or
    /// restarting ffmpeg. Playlist polls hit this path every few seconds;
    /// `generation` lets a leftover poll of an older `start=` keep the
    /// current job instead of killing it.
    pub async fn job_usable(&self, key: &str, start_seconds: f64, generation: Option<u64>) -> bool {
        let mut active = self.active.lock().await;
        let Some(job) = active.as_mut() else {
            return false;
        };
        if !job_covers_request(
            &job.key,
            job.start_seconds,
            job.generation,
            key,
            start_seconds,
            generation,
        ) {
            return false;
        }
        let finished = matches!(job.child.try_wait(), Ok(Some(_)));
        let usable = !finished || job.dir.join(PLAYLIST_NAME).exists();
        if usable {
            job.generation = job.generation.max(generation.unwrap_or(0));
        }
        usable
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

fn nonzero_generation(generation: u64) -> Option<u64> {
    (generation > 0).then_some(generation)
}

/// Whether `job` can satisfy this playlist request without restarting ffmpeg.
///
/// A matching `start` always hits the running job. A *lower* client
/// generation is a leftover hls.js poll of a previous playlist URL — those
/// used to call `ensure_job` with the old offset and kill the seek remux,
/// after which `X-Cubo-Start` reported the beginning while the picture was
/// hours later. Old clients send no generation and keep the previous
/// last-writer-wins behaviour.
fn job_covers_request(
    job_key: &str,
    job_start: f64,
    job_generation: u64,
    key: &str,
    start_seconds: f64,
    generation: Option<u64>,
) -> bool {
    if job_key != key {
        return false;
    }
    if same_start(job_start, start_seconds) {
        return true;
    }
    match generation {
        Some(gen) if gen <= job_generation => true,
        _ => false,
    }
}

/// Finds the timestamp of the last video keyframe at/before `target` — the
/// spot an input seek (`-ss`) with `-noaccurate_seek` actually lands on.
/// Packet-level scan of a narrow read interval, so this is fast (no decoding).
/// Fail when the landing cannot be measured: using the requested target as
/// playlist time zero would corrupt subtitle alignment and saved progress.
async fn find_keyframe_before(ffprobe: &Path, input_url: &str, target: f64) -> Result<f64, String> {
    // Same cold-swarm case as the source probe: the killed attempt leaves the
    // pieces it fetched in the cache, so one immediate retry usually lands.
    match find_keyframe_once(ffprobe, input_url, target, PROBE_TIMEOUT).await {
        Err(ProbeError::TimedOut) => {
            tracing::info!(target: "probe", "seek probe timed out; retrying once");
            find_keyframe_once(ffprobe, input_url, target, PROBE_TIMEOUT).await
        }
        result => result,
    }
    .map_err(|error| match error {
        ProbeError::TimedOut => {
            "probing the seek position timed out; torrent bytes are unavailable".to_string()
        }
        ProbeError::Failed(error) => error,
    })
}

#[cfg(test)]
async fn find_keyframe_before_with_timeout(
    ffprobe: &Path,
    input_url: &str,
    target: f64,
    timeout: Duration,
) -> Result<f64, String> {
    find_keyframe_once(ffprobe, input_url, target, timeout)
        .await
        .map_err(|error| match error {
            ProbeError::TimedOut => {
                "probing the seek position timed out; torrent bytes are unavailable".to_string()
            }
            ProbeError::Failed(error) => error,
        })
}

async fn find_keyframe_once(
    ffprobe: &Path,
    input_url: &str,
    target: f64,
    timeout: Duration,
) -> Result<f64, ProbeError> {
    let from = (target - 20.0).max(0.0);
    let to = target + 0.25;
    let output = tokio::time::timeout(
        timeout,
        Command::new(ffprobe)
            .args(["-v", "error", "-select_streams", "v:0"])
            .args(["-read_intervals", &format!("{from:.3}%{to:.3}")])
            .args(["-show_packets", "-show_entries", "packet=pts_time,flags"])
            .args(["-of", "csv=p=0"])
            .arg(input_url)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| ProbeError::TimedOut)?
    .map_err(|error| ProbeError::Failed(format!("could not run seek ffprobe: {error}")))?;
    if !output.status.success() {
        return Err(ProbeError::Failed(
            "ffprobe could not read the seek position".into(),
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut best: Option<f64> = None;
    for line in text.lines() {
        let mut fields = line.split(',');
        let pts = fields
            .next()
            .and_then(|field| field.trim().parse::<f64>().ok());
        let flags = fields.next().unwrap_or("");
        if let Some(pts) = pts {
            if pts.is_finite()
                && pts >= 0.0
                && flags.contains('K')
                && pts <= target + 0.001
                && best.is_none_or(|b| pts > b)
            {
                best = Some(pts);
            }
        }
    }
    if let Some(found) = best {
        tracing::debug!(
            target: "probe",
            requested_start_seconds = target,
            actual_start_seconds = found,
            "keyframe before seek target located"
        );
    } else {
        tracing::debug!(
            target: "probe",
            requested_start_seconds = target,
            "keyframe scan found no usable landing point"
        );
    }
    best.ok_or_else(|| {
        ProbeError::Failed("could not measure the keyframe at the seek position".into())
    })
}

/// Locates a bundled or system ffmpeg tool. The directory next to the CLI
/// executable is checked first so a release sidecar wins over system installs.
pub(crate) fn find_tool(name: &str) -> Option<PathBuf> {
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

#[cfg(test)]
mod tests {
    use super::{job_covers_request, same_start};

    #[test]
    fn matching_start_is_always_the_current_job() {
        assert!(job_covers_request("2:0", 9.6, 1, "2:0", 9.6, Some(1)));
        assert!(job_covers_request("2:0", 9.6, 1, "2:0", 9.6, None));
        assert!(!same_start(2601.177, 2600.0));
        assert!(same_start(2601.177, 2601.2));
    }

    #[test]
    fn stale_generation_does_not_restart_a_newer_seek() {
        // hls.js still polling start=9.6&gen=1 after a seek to 2601 gen=2.
        assert!(job_covers_request("4:0", 2601.177, 2, "4:0", 9.6, Some(1),));
    }

    #[test]
    fn newer_generation_at_a_different_start_restarts() {
        assert!(!job_covers_request("4:0", 9.6, 1, "4:0", 2601.177, Some(2),));
    }

    #[test]
    fn old_clients_without_generation_still_restart_on_seek() {
        assert!(!job_covers_request("4:0", 9.6, 0, "4:0", 2601.177, None));
    }

    #[test]
    fn a_different_file_never_reuses_the_job() {
        assert!(!job_covers_request("2:0", 0.0, 1, "4:0", 0.0, Some(1)));
    }

    mod chapters {
        use super::super::{chapter_skip_segments, Chapter};

        fn chapter(start: f64, end: f64, title: &str) -> Chapter {
            Chapter {
                start_seconds: start,
                end_seconds: end,
                title: title.to_owned(),
            }
        }

        #[test]
        fn named_intro_and_credits_are_picked() {
            // Silo S03E05's real chapter layout.
            let chapters = [
                chapter(0.0, 250.333, "Scene 1"),
                chapter(250.333, 348.125, "Intro"),
                chapter(348.125, 3092.0, "Scene 2"),
                chapter(3092.0, 3153.76, "Credits"),
            ];
            let (intro, credits) = chapter_skip_segments(&chapters, 3153.76);
            let intro = intro.expect("intro");
            assert_eq!(intro.start, 250.333);
            assert_eq!(intro.end, 348.125);
            let credits = credits.expect("credits");
            assert_eq!(credits.start, 3092.0);
            assert_eq!(credits.end, 3153.76);
        }

        #[test]
        fn generic_chapter_names_are_ignored() {
            let chapters = [
                chapter(0.0, 300.0, "Chapter 1"),
                chapter(300.0, 600.0, "Scene 2"),
                chapter(600.0, 900.0, "Chapter 3"),
            ];
            let (intro, credits) = chapter_skip_segments(&chapters, 900.0);
            assert!(intro.is_none());
            assert!(credits.is_none());
        }

        #[test]
        fn anime_op_ed_labels_match() {
            let chapters = [
                chapter(0.0, 90.0, "Prologue"),
                chapter(90.0, 180.0, "OP"),
                chapter(180.0, 1300.0, "Part A"),
                chapter(1300.0, 1390.0, "ED 2"),
            ];
            let (intro, credits) = chapter_skip_segments(&chapters, 1400.0);
            assert_eq!(intro.map(|s| (s.start, s.end)), Some((90.0, 180.0)));
            assert_eq!(credits.map(|s| (s.start, s.end)), Some((1300.0, 1390.0)));
        }

        #[test]
        fn opening_title_sequence_and_closing_match() {
            let chapters = [
                chapter(10.0, 100.0, "Opening Titles"),
                chapter(800.0, 900.0, "Closing"),
            ];
            let (intro, credits) = chapter_skip_segments(&chapters, 900.0);
            assert!(intro.is_some());
            assert!(credits.is_some());
        }

        #[test]
        fn intro_past_the_halfway_mark_is_rejected() {
            // A chapter named "Intro" two thirds in is a mislabel, not an
            // actual title sequence.
            let chapters = [chapter(700.0, 800.0, "Intro")];
            let (intro, _) = chapter_skip_segments(&chapters, 900.0);
            assert!(intro.is_none());
        }

        #[test]
        fn credits_too_early_are_rejected() {
            let chapters = [chapter(100.0, 200.0, "Credits")];
            let (_, credits) = chapter_skip_segments(&chapters, 900.0);
            assert!(credits.is_none());
        }

        #[test]
        fn invalid_ranges_and_values_are_skipped() {
            let chapters = [
                chapter(200.0, 100.0, "Intro"), // reversed
                chapter(f64::NAN, 300.0, "Opening"),
                chapter(50.0, f64::INFINITY, "Intro"),
                chapter(10.0, 90.0, "Intro"),
            ];
            let (intro, _) = chapter_skip_segments(&chapters, 900.0);
            assert_eq!(intro.map(|s| (s.start, s.end)), Some((10.0, 90.0)));
        }

        #[test]
        fn unknown_duration_still_matches_named_chapters() {
            let chapters = [
                chapter(250.0, 348.0, "Intro"),
                chapter(3000.0, 3100.0, "Credits"),
            ];
            let (intro, credits) = chapter_skip_segments(&chapters, 0.0);
            assert!(intro.is_some());
            assert!(credits.is_some());
        }

        #[test]
        fn first_named_match_wins() {
            let chapters = [
                chapter(10.0, 60.0, "Intro"),
                chapter(70.0, 120.0, "Opening"),
            ];
            let (intro, _) = chapter_skip_segments(&chapters, 900.0);
            assert_eq!(intro.map(|s| (s.start, s.end)), Some((10.0, 60.0)));
        }
    }

    #[cfg(unix)]
    mod subprocess {
        use super::super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::Arc;

        struct Fixture(PathBuf);

        impl Fixture {
            fn new() -> Self {
                let dir = std::env::temp_dir().join(format!("cubo-probe-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&dir).unwrap();
                Self(dir)
            }

            fn script(&self, name: &str, body: &str) -> PathBuf {
                let path = self.0.join(name);
                std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
                path
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        async fn wait_for_file(path: &Path) {
            tokio::time::timeout(Duration::from_secs(3), async {
                while !path.exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("probe did not start");
        }

        async fn assert_process_exits(pid_file: &Path) {
            let pid: i32 = std::fs::read_to_string(pid_file)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            tokio::time::timeout(Duration::from_secs(3), async {
                // Signal zero checks existence without sending a signal.
                while unsafe { libc::kill(pid, 0) } == 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("cancelled ffprobe was left running");
        }

        #[tokio::test]
        async fn seek_probe_timeout_kills_the_subprocess() {
            let fixture = Fixture::new();
            let probe = fixture.script(
                "ffprobe",
                r#"for input do :; done
printf '%s' "$$" > "$input"
exec sleep 30"#,
            );
            let pid_file = fixture.0.join("pid");
            let error = find_keyframe_before_with_timeout(
                &probe,
                pid_file.to_str().unwrap(),
                2584.0,
                Duration::from_secs(2),
            )
            .await
            .unwrap_err();
            assert!(error.contains("seek position timed out"));
            assert_process_exits(&pid_file).await;
        }

        #[tokio::test]
        async fn evicting_a_torrent_stops_only_its_conversion() {
            let fixture = Fixture::new();
            let mut manager = TranscodeManager::new(fixture.0.join("remux"));
            manager.ffmpeg = Some(fixture.script("ffmpeg", "exec sleep 30"));
            let probe = MediaProbe {
                video_codec: Some("h264".into()),
                audio_codec: Some("aac".into()),
                audio_stream_index: Some(1),
                duration_seconds: Some(3000.0),
                format_name: None,
                chapters: vec![],
            };
            let dir = manager
                .ensure_job("1:0", "unused", &probe, 0.0, 1)
                .await
                .unwrap();
            std::fs::write(dir.join("segment.m4s"), b"video").unwrap();
            manager
                .remove_torrent_output("2", "different")
                .await
                .unwrap();
            assert!(dir.exists());
            assert!(manager.job_dir("1:0").await.is_some());
            manager.remove_torrent_output("1", "hash").await.unwrap();
            assert!(!dir.exists());
            assert!(manager.job_dir("1:0").await.is_none());
            assert!(!manager.cache_blocked());
        }

        #[tokio::test]
        async fn clearing_cache_cancels_prewarm_and_removes_output() {
            let fixture = Fixture::new();
            let mut manager = TranscodeManager::new(fixture.0.join("remux"));
            manager.ffmpeg = Some(PathBuf::from("unused"));
            manager.ffprobe = Some(fixture.script(
                "ffprobe",
                r#"for input do :; done
printf '%s' "$$" > "$input"
exec sleep 30"#,
            ));
            let manager = Arc::new(manager);
            let pid_file = fixture.0.join("pid");
            std::fs::write(manager.dir().join("leftover.m4s"), b"old video").unwrap();
            let task_manager = manager.clone();
            let input = pid_file.to_str().unwrap().to_owned();
            let task = tokio::spawn(async move { task_manager.prewarm("1:0".into(), input).await });
            wait_for_file(&pid_file).await;
            manager.clear_cache().await.unwrap();
            tokio::time::timeout(Duration::from_secs(3), task)
                .await
                .unwrap()
                .unwrap();
            assert_process_exits(&pid_file).await;
            assert_eq!(std::fs::read_dir(manager.dir()).unwrap().count(), 0);
            assert!(manager.cache_blocked());
            assert!(manager.probes.lock().await.is_empty());
            manager.begin_cache_session();
            assert!(!manager.cache_blocked());
        }

        #[tokio::test]
        async fn cancelling_source_probe_kills_the_subprocess() {
            let fixture = Fixture::new();
            let mut manager = TranscodeManager::new(fixture.0.join("remux"));
            manager.ffprobe = Some(fixture.script(
                "ffprobe",
                r#"for input do :; done
printf '%s' "$$" > "$input"
exec sleep 30"#,
            ));
            let pid_file = fixture.0.join("pid");
            assert!(tokio::time::timeout(
                Duration::from_secs(2),
                manager.probe(pid_file.to_str().unwrap()),
            )
            .await
            .is_err());
            assert_process_exits(&pid_file).await;
        }

        #[tokio::test]
        async fn source_probe_reads_named_chapters() {
            let fixture = Fixture::new();
            let mut manager = TranscodeManager::new(fixture.0.join("remux"));
            manager.ffprobe = Some(fixture.script(
                "ffprobe",
                r#"cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264"},{"codec_type":"audio","codec_name":"aac","index":1}],
 "format":{"duration":"3153.760"},
 "chapters":[
   {"start_time":"0","end_time":"250.333","tags":{"title":"Scene 1"}},
   {"start_time":"250.333","end_time":"348.125","tags":{"title":"Intro"}},
   {"start_time":"348.125","end_time":"3092.0","tags":{"title":"Scene 2"}},
   {"start_time":"3092.0","end_time":"3153.760","tags":{"title":"Credits"}},
   {"start_time":"not-a-number","end_time":"1","tags":{"title":"Broken"}}
 ]}
JSON"#,
            ));
            let probe = manager.probe("unused").await.unwrap();
            assert_eq!(probe.duration_seconds, Some(3153.76));
            assert_eq!(probe.chapters.len(), 4);
            assert_eq!(probe.chapters[1].title, "Intro");
            assert_eq!(probe.chapters[1].start_seconds, 250.333);
            let (intro, credits) = super::super::chapter_skip_segments(
                &probe.chapters,
                probe.duration_seconds.unwrap(),
            );
            assert_eq!(intro.map(|s| (s.start, s.end)), Some((250.333, 348.125)));
            assert_eq!(credits.map(|s| (s.start, s.end)), Some((3092.0, 3153.76)));
        }

        #[tokio::test]
        async fn stalled_seek_leaves_lock_free_and_cannot_evict_newer_generation() {
            let fixture = Fixture::new();
            let mut manager = TranscodeManager::new(fixture.0.join("remux"));
            manager.ffprobe = Some(fixture.script(
                "ffprobe",
                r#"for input do :; done
printf started > "$input.started"
while [ ! -f "$input.release" ]; do sleep 0.01; done
printf '99.0,K_\n'"#,
            ));
            manager.ffmpeg = Some(fixture.script("ffmpeg", "exec sleep 30"));
            let manager = Arc::new(manager);
            let probe = MediaProbe {
                video_codec: Some("h264".into()),
                audio_codec: Some("aac".into()),
                audio_stream_index: Some(1),
                duration_seconds: Some(3000.0),
                format_name: None,
                chapters: vec![],
            };
            let input = fixture.0.join("input").to_str().unwrap().to_owned();
            let slow = tokio::spawn({
                let manager = manager.clone();
                let probe = probe.clone();
                let input = input.clone();
                async move { manager.ensure_job("1:0", &input, &probe, 100.0, 2).await }
            });
            wait_for_file(&fixture.0.join("input.started")).await;
            assert!(
                tokio::time::timeout(Duration::from_millis(200), manager.job_dir("1:0"))
                    .await
                    .expect("scan held active mutex")
                    .is_none()
            );
            let new_dir = tokio::time::timeout(
                Duration::from_secs(2),
                manager.ensure_job("1:0", &input, &probe, 0.0, 3),
            )
            .await
            .expect("new seek blocked by old probe")
            .unwrap();
            let nonce = manager.job_nonce("1:0").await;
            std::fs::write(fixture.0.join("input.release"), "").unwrap();
            assert_eq!(slow.await.unwrap().unwrap(), new_dir);
            assert_eq!(manager.job_actual_start("1:0").await, Some(0.0));
            assert_eq!(manager.job_nonce("1:0").await, nonce);
            // A newer generation reusing this offset also advances the fence.
            assert!(manager.job_usable("1:0", 0.0, Some(5)).await);
            assert!(manager.job_usable("1:0", 100.0, Some(4)).await);
            let mut active = manager.active.lock().await;
            active.as_mut().unwrap().child.kill().await.unwrap();
        }

        #[tokio::test]
        async fn keyframe_measurement_rejects_missing_and_invalid_timestamps() {
            let fixture = Fixture::new();
            let empty = fixture.script("empty", "printf 'NaN,K_\\n101,K_\\n'");
            assert!(find_keyframe_before(&empty, "unused", 100.0).await.is_err());
            let valid = fixture.script("valid", "printf '98.5,K_\\n99.75,K_\\n100.1,__\\n'");
            assert_eq!(
                find_keyframe_before(&valid, "unused", 100.0).await.unwrap(),
                99.75
            );
        }

        #[tokio::test]
        async fn real_ffmpeg_writes_hls_over_private_put_sink() {
            let Some(ffmpeg) = find_tool("ffmpeg") else {
                return;
            };
            let Some(ffprobe) = find_tool("ffprobe") else {
                return;
            };
            let fixture = Fixture::new();
            let source = fixture.0.join("source.mp4");
            let generated = Command::new(&ffmpeg)
                .args([
                    "-y",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=size=160x90:rate=5",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=8000",
                    "-t",
                    "300",
                    "-c:v",
                    "mpeg4",
                    "-b:v",
                    "4k",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "8k",
                    source.to_str().unwrap(),
                ])
                .status()
                .await
                .unwrap();
            assert!(generated.success(), "could not create ffmpeg fixture");

            let mut manager = TranscodeManager::new(fixture.0.join("remux"));
            manager.ffmpeg = Some(ffmpeg);
            manager.ffprobe = Some(ffprobe);
            const BUDGET: u64 = 8 * 1024 * 1024;
            manager.set_budget(BUDGET).await.unwrap();
            manager
                .listen_sink()
                .await
                .expect("bind local remux test listener");
            let probe = MediaProbe {
                video_codec: Some("mpeg4".into()),
                audio_codec: Some("aac".into()),
                audio_stream_index: Some(1),
                duration_seconds: Some(300.0),
                format_name: None,
                chapters: vec![],
            };
            let dir = manager
                .ensure_job("fixture:0", source.to_str().unwrap(), &probe, 0.0, 1)
                .await
                .unwrap();
            manager.wait_for_playlist(&dir).await.unwrap();
            let playlist = std::fs::read_to_string(dir.join(PLAYLIST_NAME)).unwrap();
            assert!(playlist.contains("#EXTINF:"));
            assert!(playlist.contains("#EXT-X-PLAYLIST-TYPE:EVENT"));
            assert!(dir.join("init.mp4").exists());
            // The sink applies backpressure when the quota is full of footage
            // the reader has not taken, exactly like a paused real player.
            // Mark served segments often enough that quota waits resolve on
            // the next poll rather than dominating the deadline.
            let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
            loop {
                let playlist = std::fs::read_to_string(dir.join(PLAYLIST_NAME)).unwrap_or_default();
                for line in playlist.lines().filter(|line| line.ends_with(".m4s")) {
                    let segment = line.rsplit('/').next().unwrap();
                    let _ = manager.report_segment_served("fixture:0", segment).await;
                }
                if playlist.contains("#EXT-X-ENDLIST") {
                    break;
                }
                if tokio::time::Instant::now() > deadline {
                    let names: Vec<_> = std::fs::read_dir(&dir)
                        .unwrap()
                        .flatten()
                        .map(|e| (e.file_name(), e.metadata().unwrap().len()))
                        .collect();
                    panic!("remux stalled: files={names:?}, playlist={playlist}");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let allocated = std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .filter_map(|entry| entry.metadata().ok())
                .filter(|metadata| metadata.is_file())
                .map(|metadata| metadata.len().max(1).div_ceil(64 * 1024) * 64 * 1024)
                .sum::<u64>();
            assert!(
                allocated <= BUDGET,
                "remux output exceeded quota: {allocated} > {BUDGET}"
            );

            let old_nonce = manager.job_nonce("fixture:0").await.unwrap();
            let restarted = manager
                .ensure_job("fixture:0", source.to_str().unwrap(), &probe, 200.0, 2)
                .await
                .unwrap();
            assert_ne!(manager.job_nonce("fixture:0").await.unwrap(), old_nonce);
            assert!(manager.job_actual_start("fixture:0").await.unwrap() <= 200.0);
            assert!(manager.job_usable("fixture:0", 0.0, Some(1)).await);
            assert_eq!(restarted, manager.job_dir("fixture:0").await.unwrap());
            manager
                .remove_torrent_output("fixture", "unused")
                .await
                .unwrap();
        }
    }
}
