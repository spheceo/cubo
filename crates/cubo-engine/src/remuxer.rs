//! Produces a session's HLS segments on demand.
//!
//! One ffmpeg job at a time converts the source from some planned segment
//! onwards into a continuous fragmented-MP4 stream on stdout. Its fragments
//! are filed under the session's fixed [`SegmentPlan`], so a segment's
//! content never depends on which job produced it: seeking far away simply
//! starts a new job at that segment, and nothing else about the playlist,
//! timestamps or URLs changes.
//!
//! Flow control is plain backpressure: when the job is far enough ahead of
//! the viewer it stops reading ffmpeg's stdout, ffmpeg blocks, and it stops
//! pulling torrent data. There is no separate "window" machinery to keep in
//! sync with the player.
//!
//! Load-bearing ffmpeg flags (verified against real B-frame sources):
//! - `-copyts` + `-movflags frag_discont`: fragment decode times are the
//!   source's own timestamps, identical across jobs, so segments from
//!   different jobs splice cleanly and one init segment serves them all.
//! - `-output_ts_offset`: sources with B-frames start at a negative decode
//!   time; the offset keeps every timestamp positive so the muxer never
//!   shifts (or wraps) the first fragment.
//! - `-noaccurate_seek`: audio starts at the landing keyframe together with
//!   copied video instead of being trimmed to the seek target — the A/V
//!   sync fix from the previous pipeline, still required here.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::watch;

use crate::fmp4::{Fmp4Event, Fmp4Splitter};
use crate::segment_plan::SegmentPlan;

/// Added to every output timestamp; subtracted again when filing fragments.
pub const OUTPUT_TS_OFFSET: f64 = 60.0;
/// How far past the viewer's position a job may convert before it pauses.
const AHEAD_SECONDS: f64 = 150.0;
/// Converted media kept behind the viewer for instant short rewinds.
const BEHIND_SECONDS: f64 = 240.0;
/// Hard cap on converted segments kept on disk per session.
const SEGMENT_BUDGET_BYTES: u64 = 1536 * 1024 * 1024;
/// A request this far past the running job's position starts a new job
/// there rather than waiting for sequential conversion to arrive.
const RESTART_DISTANCE_SECONDS: f64 = 24.0;
/// Consecutive failed jobs at the same position before a request errors.
const MAX_FAILURES: u32 = 3;

#[derive(Debug, Clone)]
pub struct RemuxInput {
    pub ffmpeg: PathBuf,
    /// Loopback URL of the source file (rqbit's ranged stream).
    pub url: String,
    /// Absolute stream index of the audio to keep; `None` takes the first.
    pub audio_stream_index: Option<u32>,
    pub audio_copy: bool,
    pub hevc: bool,
    /// Source time of playlist zero (the first keyframe; usually 0).
    pub origin: f64,
}

#[derive(Debug)]
pub enum RemuxError {
    Closed,
    TimedOut,
    Failed(String),
}

impl std::fmt::Display for RemuxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RemuxError::Closed => write!(f, "playback session closed"),
            RemuxError::TimedOut => write!(f, "timed out waiting for the source"),
            RemuxError::Failed(error) => write!(f, "{error}"),
        }
    }
}

struct Job {
    id: u64,
    start: usize,
    /// The segment the job is assembling (or will assemble next).
    cursor: usize,
    finished: bool,
    error: Option<String>,
    task: tokio::task::JoinHandle<()>,
    last_output: Instant,
}

impl Drop for Job {
    fn drop(&mut self) {
        // Aborting drops the child process handle, which kills ffmpeg.
        self.task.abort();
    }
}

#[derive(Default)]
struct State {
    init: Option<Bytes>,
    segments: BTreeMap<usize, u64>,
    job: Option<Job>,
    next_job_id: u64,
    /// Segment the viewer is at or asked for most recently.
    focus: usize,
    failures: BTreeMap<usize, u32>,
    closed: bool,
    /// Bytes of converted media written in this session (for status).
    produced_bytes: u64,
    restarts: u64,
}

pub struct Remuxer {
    input: RemuxInput,
    plan: SegmentPlan,
    dir: PathBuf,
    state: Mutex<State>,
    version: watch::Sender<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemuxStatus {
    pub segments_ready: usize,
    pub job_start: Option<usize>,
    pub job_cursor: Option<usize>,
    pub job_error: Option<String>,
    pub focus: usize,
    /// Seconds since the running job last produced output while it still
    /// had room to convert — i.e. how long it has been starved of source
    /// data. `None` when idle, finished or deliberately paused ahead.
    pub starved_seconds: Option<f64>,
    pub restarts: u64,
}

impl Remuxer {
    pub fn new(input: RemuxInput, plan: SegmentPlan, dir: PathBuf) -> Arc<Self> {
        let (version, _) = watch::channel(0);
        Arc::new(Self {
            input,
            plan,
            dir,
            state: Mutex::new(State::default()),
            version,
        })
    }

    pub fn plan(&self) -> &SegmentPlan {
        &self.plan
    }

    fn bump(&self) {
        self.version.send_modify(|value| *value = value.wrapping_add(1));
    }

    /// Highest segment the running job may complete before pausing.
    fn limit(&self, state: &State) -> usize {
        let from = self.plan.start(state.focus.min(self.plan.len() - 1));
        self.plan.index_at(from + AHEAD_SECONDS)
    }

    /// Reports the viewer's position (heartbeats). Moves the conversion
    /// window and lets a paused job continue.
    pub fn set_playhead(self: &Arc<Self>, seconds: f64) {
        let index = self.plan.index_at(seconds.max(0.0));
        let changed = {
            let mut state = self.state.lock().unwrap();
            let changed = state.focus != index;
            state.focus = index;
            changed
        };
        if changed {
            self.bump();
            self.enforce_retention();
        }
    }

    /// Starts converting at `seconds` ahead of any request, so the first
    /// segment is (nearly) ready when the player asks for it.
    pub fn warm(self: &Arc<Self>, seconds: f64) {
        let index = self.plan.index_at(seconds.max(0.0));
        let mut state = self.state.lock().unwrap();
        state.focus = index;
        if state.job.is_none() && !state.closed {
            self.start_job(&mut state, index);
        }
    }

    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.job = None;
        drop(state);
        self.bump();
        let dir = self.dir.clone();
        tokio::spawn(async move {
            let _ = tokio::fs::remove_dir_all(dir).await;
        });
    }

    pub fn status(&self) -> RemuxStatus {
        let state = self.state.lock().unwrap();
        let limit = self.limit(&state);
        let job = state.job.as_ref();
        RemuxStatus {
            segments_ready: state.segments.len(),
            job_start: job.map(|job| job.start),
            job_cursor: job.map(|job| job.cursor),
            job_error: job.and_then(|job| job.error.clone()),
            focus: state.focus,
            starved_seconds: job
                .filter(|job| !job.finished && job.error.is_none() && job.cursor <= limit)
                .map(|job| job.last_output.elapsed().as_secs_f64()),
            restarts: state.restarts,
        }
    }

    pub async fn init_segment(self: &Arc<Self>, timeout: Duration) -> Result<Bytes, RemuxError> {
        let deadline = Instant::now() + timeout;
        let mut changes = self.version.subscribe();
        loop {
            {
                let mut state = self.state.lock().unwrap();
                if state.closed {
                    return Err(RemuxError::Closed);
                }
                if let Some(init) = &state.init {
                    return Ok(init.clone());
                }
                let needs_job = match &state.job {
                    None => true,
                    Some(job) => job.error.is_some() || job.finished,
                };
                if needs_job {
                    let focus = state.focus;
                    let failures = state.failures.get(&focus).copied().unwrap_or(0);
                    if failures >= MAX_FAILURES {
                        return Err(RemuxError::Failed(
                            state
                                .job
                                .as_ref()
                                .and_then(|job| job.error.clone())
                                .unwrap_or_else(|| "the converter keeps failing".into()),
                        ));
                    }
                    self.start_job(&mut state, focus);
                }
            }
            wait_for_change(&mut changes, deadline).await?;
        }
    }

    pub async fn segment(self: &Arc<Self>, index: usize, timeout: Duration) -> Result<Bytes, RemuxError> {
        if index >= self.plan.len() {
            return Err(RemuxError::Failed("segment is past the end".into()));
        }
        let deadline = Instant::now() + timeout;
        let mut changes = self.version.subscribe();
        {
            let mut state = self.state.lock().unwrap();
            if state.focus != index {
                state.focus = index;
                drop(state);
                self.bump();
            }
        }
        loop {
            let ready = {
                let mut state = self.state.lock().unwrap();
                if state.closed {
                    return Err(RemuxError::Closed);
                }
                if state.segments.contains_key(&index) {
                    true
                } else {
                    self.ensure_job_for(&mut state, index)?;
                    false
                }
            };
            if ready {
                match tokio::fs::read(self.segment_path(index)).await {
                    Ok(bytes) => return Ok(Bytes::from(bytes)),
                    Err(_) => {
                        // Retention removed it between the check and the read.
                        self.state.lock().unwrap().segments.remove(&index);
                        continue;
                    }
                }
            }
            wait_for_change(&mut changes, deadline).await?;
        }
    }

    /// Makes sure some job will produce `index`, starting one if needed.
    fn ensure_job_for(self: &Arc<Self>, state: &mut State, index: usize) -> Result<(), RemuxError> {
        let reusable = state.job.as_ref().is_some_and(|job| {
            job.error.is_none()
                && !job.finished
                && job.start <= index
                && self.plan.start(index) - self.plan.start(job.cursor.min(self.plan.len() - 1))
                    <= RESTART_DISTANCE_SECONDS
                && index >= job.cursor
        });
        if reusable {
            return Ok(());
        }
        // A job that died at this very spot: retry a bounded number of times.
        if let Some(job) = &state.job {
            if job.error.is_some() && job.start == index {
                let failures = state.failures.get(&index).copied().unwrap_or(0);
                if failures >= MAX_FAILURES {
                    return Err(RemuxError::Failed(job.error.clone().unwrap_or_default()));
                }
            }
        }
        self.start_job(state, index);
        Ok(())
    }

    fn start_job(self: &Arc<Self>, state: &mut State, start: usize) {
        state.next_job_id += 1;
        if state.job.is_some() {
            state.restarts += 1;
        }
        let id = state.next_job_id;
        let this = Arc::clone(self);
        let task = tokio::spawn(async move {
            let result = this.run_job(id, start).await;
            let mut state = this.state.lock().unwrap();
            if let Some(job) = state.job.as_mut().filter(|job| job.id == id) {
                match result {
                    Ok(()) => {
                        job.finished = true;
                        state.failures.remove(&start);
                    }
                    Err(error) => {
                        tracing::warn!(target: "remux", start, %error, "remux job failed");
                        job.error = Some(error);
                        *state.failures.entry(start).or_default() += 1;
                    }
                }
            }
            drop(state);
            this.bump();
        });
        tracing::info!(target: "remux", start, start_seconds = self.plan.start(start), "session remux job started");
        state.job = Some(Job {
            id,
            start,
            cursor: start,
            finished: false,
            error: None,
            task,
            last_output: Instant::now(),
        });
    }

    fn command(&self, start: usize) -> Command {
        let input = &self.input;
        let mut command = Command::new(&input.ffmpeg);
        command
            .args(["-nostdin", "-v", "error"])
            .args(["-analyzeduration", "10M", "-probesize", "5M"]);
        if let Some(target) = self.plan.seek_target(start) {
            // -noaccurate_seek is load-bearing for A/V sync (module docs).
            command.args(["-noaccurate_seek", "-ss", &format!("{target:.3}")]);
        }
        command.args(["-copyts", "-i", &input.url]).args(["-map", "0:v:0"]);
        match input.audio_stream_index {
            Some(index) => command.args(["-map", &format!("0:{index}")]),
            None => command.args(["-map", "0:a:0?"]),
        };
        command.args(["-c:v", "copy"]);
        if input.hevc {
            // Browsers only accept HEVC in MP4 with the hvc1 tag.
            command.args(["-tag:v", "hvc1"]);
        }
        if input.audio_copy {
            command.args(["-c:a", "copy"]);
        } else {
            command.args(["-c:a", "aac", "-ac", "2", "-b:a", "192k"]);
        }
        command
            .args(["-sn", "-dn"])
            .args(["-avoid_negative_ts", "disabled"])
            .args(["-output_ts_offset", &format!("{OUTPUT_TS_OFFSET}")])
            .args(["-max_muxing_queue_size", "4096"])
            .args(["-f", "mp4"])
            .args([
                "-movflags",
                "frag_keyframe+empty_moov+default_base_moof+frag_discont",
            ])
            .arg("pipe:1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    async fn run_job(self: &Arc<Self>, id: u64, start: usize) -> Result<(), String> {
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|error| format!("could not create segment folder: {error}"))?;
        let mut child = self
            .command(start)
            .spawn()
            .map_err(|error| format!("could not start ffmpeg: {error}"))?;
        let stdout = child.stdout.take().ok_or("ffmpeg has no stdout")?;
        let stderr = child.stderr.take();
        let error_tail = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = stderr {
            let tail = error_tail.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut buffer = vec![0u8; 4096];
                while let Ok(count) = reader.read(&mut buffer).await {
                    if count == 0 {
                        break;
                    }
                    let mut tail = tail.lock().unwrap();
                    tail.push_str(&String::from_utf8_lossy(&buffer[..count]));
                    if tail.len() > 2000 {
                        let cut = tail.len() - 2000;
                        let boundary = (cut..tail.len()).find(|at| tail.is_char_boundary(*at)).unwrap_or(0);
                        tail.drain(..boundary);
                    }
                }
            });
        }

        let mut reader = BufReader::with_capacity(256 * 1024, stdout);
        let mut splitter = Fmp4Splitter::new();
        let mut buffer = vec![0u8; 256 * 1024];
        let mut current: Option<(usize, Vec<u8>)> = None;
        let mut changes = self.version.subscribe();
        loop {
            let count = reader
                .read(&mut buffer)
                .await
                .map_err(|error| format!("reading ffmpeg output failed: {error}"))?;
            if count == 0 {
                break;
            }
            self.touch_job(id);
            for event in splitter.push(&buffer[..count])? {
                match event {
                    Fmp4Event::Init(init) => {
                        let mut state = self.state.lock().unwrap();
                        if state.init.is_none() {
                            state.init = Some(init);
                            drop(state);
                            self.bump();
                        }
                    }
                    Fmp4Event::Fragment(fragment) => {
                        let time = fragment.video_start - OUTPUT_TS_OFFSET - self.input.origin;
                        let index = self.plan.index_for_fragment(time);
                        if index < start {
                            // Pre-roll from a landing keyframe before the boundary.
                            continue;
                        }
                        // Never leave a planned segment empty: a stretch with
                        // no keyframe (only possible on grid plans) files its
                        // next fragment under the first unfilled segment.
                        let next = current.as_ref().map_or(start, |(open, _)| open + 1);
                        let index = index.min(next);
                        match current.as_mut() {
                            Some((open, bytes)) if *open == index => {
                                bytes.extend_from_slice(&fragment.bytes);
                            }
                            _ => {
                                if let Some((done, bytes)) = current.take() {
                                    self.store_segment(id, done, bytes).await?;
                                }
                                self.set_cursor(id, index);
                                self.wait_for_room(id, index, &mut changes).await?;
                                current = Some((index, fragment.bytes.to_vec()));
                            }
                        }
                    }
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|error| format!("ffmpeg did not exit cleanly: {error}"))?;
        if !status.success() {
            let tail = error_tail.lock().unwrap().trim().to_owned();
            return Err(if tail.is_empty() {
                format!("ffmpeg exited with {status}")
            } else {
                format!("ffmpeg failed: {tail}")
            });
        }
        if let Some((done, bytes)) = current.take() {
            self.store_segment(id, done, bytes).await?;
        }
        self.set_cursor(id, self.plan.len());
        Ok(())
    }

    fn touch_job(&self, id: u64) {
        let mut state = self.state.lock().unwrap();
        if let Some(job) = state.job.as_mut().filter(|job| job.id == id) {
            job.last_output = Instant::now();
        }
    }

    fn set_cursor(&self, id: u64, cursor: usize) {
        let mut state = self.state.lock().unwrap();
        if let Some(job) = state.job.as_mut().filter(|job| job.id == id) {
            job.cursor = cursor;
            job.last_output = Instant::now();
        }
    }

    /// Blocks the job (and therefore ffmpeg) while `index` is too far ahead.
    async fn wait_for_room(&self, id: u64, index: usize, changes: &mut watch::Receiver<u64>) -> Result<(), String> {
        loop {
            {
                let state = self.state.lock().unwrap();
                if state.closed || state.job.as_ref().is_none_or(|job| job.id != id) {
                    return Err("superseded".into());
                }
                if index <= self.limit(&state) {
                    return Ok(());
                }
            }
            if changes.changed().await.is_err() {
                return Err("session ended".into());
            }
            // Paused on purpose: not starved.
            self.touch_job(id);
        }
    }

    fn segment_path(&self, index: usize) -> PathBuf {
        self.dir.join(format!("{index}.m4s"))
    }

    async fn store_segment(&self, id: u64, index: usize, bytes: Vec<u8>) -> Result<(), String> {
        let path = self.segment_path(index);
        let temp = self.dir.join(format!("{index}.m4s.{id}.tmp"));
        let length = bytes.len() as u64;
        tokio::fs::write(&temp, &bytes)
            .await
            .map_err(|error| format!("could not write segment: {error}"))?;
        tokio::fs::rename(&temp, &path)
            .await
            .map_err(|error| format!("could not store segment: {error}"))?;
        {
            let mut state = self.state.lock().unwrap();
            state.segments.insert(index, length);
            state.produced_bytes += length;
            if let Some(job) = state.job.as_mut().filter(|job| job.id == id) {
                job.cursor = index + 1;
            }
        }
        self.bump();
        self.enforce_retention();
        Ok(())
    }

    /// Drops converted media far from the viewer. The source file stays on
    /// disk, so anything dropped here can be reconverted in moments.
    fn enforce_retention(&self) {
        let removed: Vec<usize> = {
            let mut state = self.state.lock().unwrap();
            let focus_time = self.plan.start(state.focus.min(self.plan.len() - 1));
            let mut removed = Vec::new();
            let too_far: Vec<usize> = state
                .segments
                .keys()
                .copied()
                .filter(|index| {
                    let start = self.plan.start(*index);
                    start < focus_time - BEHIND_SECONDS || start > focus_time + AHEAD_SECONDS * 2.0
                })
                .collect();
            for index in too_far {
                state.segments.remove(&index);
                removed.push(index);
            }
            let mut total: u64 = state.segments.values().sum();
            while total > SEGMENT_BUDGET_BYTES {
                let focus = state.focus;
                let Some(farthest) = state
                    .segments
                    .keys()
                    .copied()
                    .filter(|index| *index < focus || *index > focus + 2)
                    .max_by_key(|index| index.abs_diff(focus))
                else {
                    break;
                };
                total -= state.segments.remove(&farthest).unwrap_or(0);
                removed.push(farthest);
            }
            removed
        };
        for index in removed {
            let _ = std::fs::remove_file(self.segment_path(index));
        }
    }
}

async fn wait_for_change(changes: &mut watch::Receiver<u64>, deadline: Instant) -> Result<(), RemuxError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(RemuxError::TimedOut);
    }
    match tokio::time::timeout(remaining, changes.changed()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(RemuxError::Closed),
        Err(_) => Err(RemuxError::TimedOut),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mkv_index::{read_index, SliceSource};
    use crate::test_support::{ffmpeg, fixture_mkv, fragment_times, FixtureSpec};

    async fn remuxer_for(spec: FixtureSpec) -> Option<Arc<Remuxer>> {
        let ffmpeg = ffmpeg()?;
        let path = fixture_mkv(spec)?;
        let bytes = std::fs::read(&path).ok()?;
        let index = read_index(&SliceSource(&bytes)).await.ok()?;
        let plan = SegmentPlan::from_keyframes(&index.keyframes, index.duration_seconds?);
        let dir = std::env::temp_dir().join(format!("cubo-remux-{}", uuid::Uuid::new_v4()));
        Some(Remuxer::new(
            RemuxInput {
                ffmpeg,
                url: path.to_string_lossy().into_owned(),
                audio_stream_index: None,
                audio_copy: false,
                hevc: spec.hevc,
                origin: 0.0,
            },
            plan,
            dir,
        ))
    }

    fn assert_segment_fits(remuxer: &Remuxer, init: &[u8], index: usize, segment: &[u8]) {
        let plan = remuxer.plan();
        let times = fragment_times(init, segment, OUTPUT_TS_OFFSET);
        assert!(!times.is_empty(), "segment {index} has no fragments");
        let (first, _) = times[0];
        let (_, last) = times[times.len() - 1];
        assert!(
            (first - plan.start(index)).abs() < 0.2,
            "segment {index} starts at {first}, planned {}",
            plan.start(index)
        );
        assert!(
            last <= plan.end(index) + 0.25,
            "segment {index} ends at {last}, planned {}",
            plan.end(index)
        );
        for pair in times.windows(2) {
            assert!((pair[1].0 - pair[0].1).abs() < 0.05, "gap inside segment {index}: {pair:?}");
        }
    }

    async fn check(remuxer: &Arc<Remuxer>, init: &[u8], index: usize) {
        let segment = remuxer
            .segment(index, Duration::from_secs(60))
            .await
            .unwrap_or_else(|error| panic!("segment {index}: {error}"));
        assert_segment_fits(remuxer, init, index, &segment);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn segments_match_the_plan_across_seek_jobs() {
        for spec in [
            FixtureSpec::default(),
            FixtureSpec { hevc: true, keyframe_every: 5.3, ..FixtureSpec::default() },
            FixtureSpec { b_frames: false, keyframe_every: 2.1, ..FixtureSpec::default() },
        ] {
            let Some(remuxer) = remuxer_for(spec).await else {
                eprintln!("skipping: ffmpeg or fixture unavailable");
                return;
            };
            let count = remuxer.plan().len();
            assert!(count > 8, "fixture too short for the test");
            let init = remuxer.init_segment(Duration::from_secs(60)).await.unwrap();
            for index in 0..4 {
                check(&remuxer, &init, index).await;
            }
            // Far seek starts a new job; its output must file identically.
            check(&remuxer, &init, count - 3).await;
            check(&remuxer, &init, count - 2).await;
            check(&remuxer, &init, count - 1).await;
            // Seek back behind the running job.
            check(&remuxer, &init, count / 2).await;
            check(&remuxer, &init, count / 2 + 1).await;
            assert!(remuxer.status().restarts >= 2);
            remuxer.close();
        }
    }
}
