//! Playback soak harness: a real Core, a real (rate-limited) local swarm and
//! a virtual player that watches several episodes back to back — playing,
//! seeking forward and back, heartbeating, auto-advancing — while measuring
//! every stall.
//!
//! It exists because every previous playback fix was verified by watching
//! one episode by hand, and the failures that matter show up 40 minutes
//! into the second. Run it with `just soak`; tune with:
//!
//! - `CUBO_SOAK_SPEED`            media seconds per wall second (default 12)
//! - `CUBO_SOAK_EPISODE_SECONDS`  episode length (default 1200)
//! - `CUBO_SOAK_BANDWIDTH`        swarm speed as a multiple of the (sped-up)
//!   playback bitrate (default 2.0 — a modest real swarm; below 1.0 the
//!   source is slower than playback and stalls are physics, not bugs)
//!
//! `CUBO_SOAK_SPEED=1 CUBO_SOAK_EPISODE_SECONDS=3600` is a real-time,
//! multi-hour session.

use std::collections::BTreeSet;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use librqbit::limits::LimitsConfig;
use librqbit::spawn_utils::BlockingSpawner;
use librqbit::{create_torrent, AddTorrent, AddTorrentOptions, CreateTorrentOptions, Session, SessionOptions};
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::engine::{spawn_test_core, TestCore};
use crate::remuxer::OUTPUT_TS_OFFSET;
use crate::test_support::{ffmpeg, fixture_long_mkv, fixture_mp4, fragment_times, FixtureSpec};

const PIECE_BYTES: u32 = 256 * 1024;
/// Media the virtual player keeps buffered ahead (hls.js-like).
const BUFFER_AHEAD: f64 = 60.0;
const HEARTBEAT_EVERY: Duration = Duration::from_secs(2);

fn env_f64(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

struct Torrent {
    magnet: String,
}

async fn seed(seeder: &Arc<Session>, content: &Path, name: &str, upload_kbps: u32) -> Torrent {
    let torrent = create_torrent(
        content,
        CreateTorrentOptions {
            name: Some(name),
            piece_length: Some(PIECE_BYTES),
            ..Default::default()
        },
        &BlockingSpawner::new(2),
    )
    .await
    .expect("create torrent");
    let magnet = format!("magnet:?xt=urn:btih:{}", torrent.info_hash().as_string());
    // Multi-file torrents map straight into output_folder; single files sit
    // next to it.
    let output = if content.is_dir() { content } else { content.parent().unwrap() };
    let handle = seeder
        .add_torrent(
            AddTorrent::from_bytes(torrent.as_bytes().unwrap()),
            Some(AddTorrentOptions {
                overwrite: true,
                output_folder: Some(output.to_string_lossy().into_owned()),
                ratelimits: LimitsConfig {
                    upload_bps: NonZeroU32::new(upload_kbps * 1024),
                    download_bps: None,
                },
                ..Default::default()
            }),
        )
        .await
        .expect("seed torrent")
        .into_handle()
        .expect("seed handle");
    tokio::time::timeout(Duration::from_secs(120), handle.wait_until_completed())
        .await
        .expect("seeder verify timeout")
        .expect("seeder verify");
    Torrent { magnet }
}

#[derive(Clone, Copy, Debug)]
enum Seek {
    /// Jump by this many seconds from the playhead.
    By(f64),
    /// Jump to this fraction of the duration.
    To(f64),
}

struct Episode {
    label: &'static str,
    magnet: String,
    /// `tv:<id>:<season>:<episode>` lets Core pick a pack file by name when
    /// no index is given (Torrentio omits it for some packs).
    media_key: String,
    file_index: Option<usize>,
    expected_file: &'static str,
    /// For direct play: the bytes the player must receive.
    source: PathBuf,
    resume: f64,
    /// Seeks fired when playback passes each fraction of the duration.
    seeks: Vec<(f64, Seek)>,
}

#[derive(Debug, Default, serde::Serialize)]
struct Report {
    label: &'static str,
    mode: String,
    ready_ms: u64,
    first_frame_ms: u64,
    media_seconds: f64,
    stalls: u32,
    stall_seconds: f64,
    max_stall_seconds: f64,
    seek_latencies: Vec<f64>,
    segments: usize,
    fetch_errors: u32,
    remux_restarts: u64,
}

struct Client {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl Client {
    fn new(core: &TestCore) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(90))
                .build()
                .unwrap(),
            base: core.base_url.clone(),
            token: core.token.clone(),
        }
    }

    async fn json(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.expect("core request");
        let status = response.status().as_u16();
        let value = response.json::<Value>().await.unwrap_or(Value::Null);
        (status, value)
    }

    fn media_url(&self, session: &str, file: &str) -> String {
        format!("{}/v1/sessions/{session}/{file}?token={}", self.base, self.token)
    }
}

/// Shared between the playback clock and the fetcher, like a <video>
/// element and hls.js.
struct Buffer {
    playhead: f64,
    /// Segments (HLS) or 1 MB chunks (direct) held by the "media element".
    held: BTreeSet<usize>,
    errors: u32,
    fetched: usize,
    failure: Option<String>,
}

async fn wait_ready(client: &Client, id: &str) -> Value {
    let started = Instant::now();
    loop {
        let (status, body) = client
            .json(reqwest::Method::GET, &format!("/v1/sessions/{id}"), None)
            .await;
        assert_eq!(status, 200, "session status: {body}");
        match body["phase"].as_str() {
            Some("ready") => return body,
            Some("failed") => panic!("session failed: {body}"),
            _ => {}
        }
        assert!(started.elapsed() < Duration::from_secs(120), "session never became ready: {body}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Plays one episode to the end. `unit_of(time)` maps a media time to the
/// unit (segment or chunk) that must be held to show it; `fetch(unit)`
/// retrieves and validates one unit.
#[allow(clippy::too_many_arguments)]
async fn play<F, Fut>(
    client: &Client,
    session: &str,
    episode: &Episode,
    duration: f64,
    unit_count: usize,
    unit_of: impl Fn(f64) -> usize + Send + Sync + 'static,
    unit_start: impl Fn(usize) -> f64 + Send + Sync + 'static,
    fetch: F,
    report: &mut Report,
    started: Instant,
) where
    F: Fn(usize) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<(), String>> + Send,
{
    let speed = env_f64("CUBO_SOAK_SPEED", 12.0);
    let unit_of = Arc::new(unit_of);
    let unit_start = Arc::new(unit_start);
    let buffer = Arc::new(Mutex::new(Buffer {
        playhead: episode.resume,
        held: BTreeSet::new(),
        errors: 0,
        fetched: 0,
        failure: None,
    }));
    // Bumped on every seek: an in-flight fetch for the old position is
    // abandoned, as hls.js aborts its fragment loader.
    let (seek_tx, seek_rx) = watch::channel(0u64);
    let (stop_tx, stop_rx) = watch::channel(false);
    let fetcher = {
        let buffer = buffer.clone();
        let unit_of = unit_of.clone();
        let unit_start = unit_start.clone();
        let mut seek_rx = seek_rx.clone();
        let stop_rx = stop_rx.clone();
        tokio::spawn(async move {
            loop {
                let stopped = *stop_rx.borrow();
                if stopped {
                    return;
                }
                let next = {
                    let state = buffer.lock().unwrap();
                    let from = unit_of(state.playhead);
                    (from..unit_count)
                        .find(|unit| !state.held.contains(unit))
                        .filter(|unit| unit_start(*unit) - state.playhead < BUFFER_AHEAD)
                };
                let Some(unit) = next else {
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    continue;
                };
                seek_rx.borrow_and_update();
                let result = tokio::select! {
                    result = fetch(unit) => Some(result),
                    _ = seek_rx.changed() => None,
                };
                let retry = {
                    let mut state = buffer.lock().unwrap();
                    match result {
                        Some(Ok(())) => {
                            state.held.insert(unit);
                            state.fetched += 1;
                            false
                        }
                        Some(Err(error)) => {
                            eprintln!("  fetch error: {error}");
                            state.errors += 1;
                            if state.errors > 20 {
                                state.failure = Some(error);
                                return;
                            }
                            true
                        }
                        None => false,
                    }
                };
                if retry {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        })
    };

    let mut seeks = episode.seeks.clone();
    let mut last_tick = Instant::now();
    let mut last_heartbeat = Instant::now() - HEARTBEAT_EVERY;
    let mut first_frame = false;
    let mut seek_started: Option<Instant> = None;
    let mut stall_started: Option<Instant> = None;
    let mut seek_generation = 0u64;
    loop {
        tokio::time::sleep(Duration::from_millis(40)).await;
        let now = Instant::now();
        let wall = now.duration_since(last_tick).as_secs_f64();
        last_tick = now;
        let (playhead, covered) = {
            let mut state = buffer.lock().unwrap();
            if let Some(failure) = &state.failure {
                panic!("{}: playback failed: {failure}", episode.label);
            }
            let unit = unit_of(state.playhead);
            let covered = state.held.contains(&unit);
            if covered {
                // Advance, but never past the end of the held range.
                let mut limit = unit;
                while state.held.contains(&(limit + 1)) {
                    limit += 1;
                }
                let held_until = if limit + 1 >= unit_count { duration } else { unit_start(limit + 1) };
                state.playhead = (state.playhead + wall * speed).min(held_until).min(duration);
                // Back buffer, like MSE eviction behind the playhead.
                let behind = unit_of((state.playhead - 90.0).max(0.0));
                state.held.retain(|held| *held >= behind);
            }
            (state.playhead, covered)
        };

        if covered {
            if !first_frame {
                first_frame = true;
                report.first_frame_ms = started.elapsed().as_millis() as u64;
            }
            if let Some(since) = seek_started.take() {
                report.seek_latencies.push(since.elapsed().as_secs_f64());
            }
            if let Some(since) = stall_started.take() {
                let length = since.elapsed().as_secs_f64();
                report.stalls += 1;
                report.stall_seconds += length;
                report.max_stall_seconds = report.max_stall_seconds.max(length);
                eprintln!("  [{}] stall of {length:.2}s at {playhead:.1}s", episode.label);
            }
        } else if first_frame && seek_started.is_none() && stall_started.is_none() && playhead < duration - 0.5 {
            stall_started = Some(now);
        }

        if now.duration_since(last_heartbeat) >= HEARTBEAT_EVERY {
            last_heartbeat = now;
            let (status, body) = client
                .json(
                    reqwest::Method::POST,
                    &format!("/v1/sessions/{session}/heartbeat"),
                    Some(json!({ "positionSeconds": playhead, "playing": covered })),
                )
                .await;
            assert!(status == 204 || status == 200, "heartbeat {status}: {body}");
        }

        if let Some(position) = seeks.iter().position(|(at, _)| playhead >= at * duration) {
            let (_, seek) = seeks.remove(position);
            let target = match seek {
                Seek::By(delta) => playhead + delta,
                Seek::To(fraction) => fraction * duration,
            }
            .clamp(0.0, duration - 5.0);
            eprintln!("  [{}] seek {playhead:.1}s -> {target:.1}s", episode.label);
            buffer.lock().unwrap().playhead = target;
            seek_generation += 1;
            let _ = seek_tx.send(seek_generation);
            stall_started = None;
            seek_started = Some(Instant::now());
        }

        if playhead >= duration - 0.5 {
            break;
        }
    }
    let _ = stop_tx.send(true);
    fetcher.abort();
    let state = buffer.lock().unwrap();
    report.segments = state.fetched;
    report.fetch_errors = state.errors;
    report.media_seconds = duration - episode.resume;
}

fn playlist_starts(text: &str) -> Vec<f64> {
    let mut starts = Vec::new();
    let mut at = 0.0;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            starts.push(at);
            at += rest.trim_end_matches(',').parse::<f64>().unwrap();
        }
    }
    starts
}

async fn watch_episode(client: &Client, episode: &Episode, peer: std::net::SocketAddr) -> (Report, Value) {
    let started = Instant::now();
    let (status, created) = client
        .json(
            reqwest::Method::POST,
            "/v1/sessions",
            Some(json!({
                "magnet": episode.magnet,
                "fileIndex": episode.file_index,
                "resumeSeconds": episode.resume,
                "hevc": true,
                "peers": [peer],
                "mediaKey": episode.media_key,
            })),
        )
        .await;
    assert_eq!(status, 201, "create session: {created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let ready = wait_ready(client, &id).await;
    assert_eq!(
        ready["fileName"].as_str(),
        Some(episode.expected_file),
        "{}: Core picked the wrong file",
        episode.label
    );
    let mut report = Report {
        label: episode.label,
        mode: ready["mode"].as_str().unwrap_or("?").to_owned(),
        ready_ms: started.elapsed().as_millis() as u64,
        ..Default::default()
    };
    let duration = ready["durationSeconds"].as_f64().expect("duration");

    if report.mode == "hls" {
        let playlist = client
            .http
            .get(client.media_url(&id, "hls/media.m3u8"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(playlist.contains("#EXT-X-ENDLIST"), "playlist is not VOD");
        let starts = Arc::new(playlist_starts(&playlist));
        let init = client
            .http
            .get(client.media_url(&id, "hls/init.mp4"))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let count = starts.len();
        let lookup = starts.clone();
        let unit_start = starts.clone();
        let fetch_starts = starts.clone();
        let http = client.http.clone();
        let base = client.media_url(&id, "hls/");
        let init = Arc::new(init);
        let label = episode.label;
        let fetch = move |unit: usize| {
            let http = http.clone();
            let url = base.replacen("hls/?", &format!("hls/{unit}.m4s?"), 1);
            let init = init.clone();
            let starts = fetch_starts.clone();
            async move {
                let response = http.get(url).send().await.map_err(|error| error.to_string())?;
                if !response.status().is_success() {
                    return Err(format!("segment {unit}: HTTP {}", response.status()));
                }
                let bytes = response.bytes().await.map_err(|error| error.to_string())?;
                let times = fragment_times(&init, &bytes, OUTPUT_TS_OFFSET);
                let planned = starts[unit];
                let first = times.first().map(|time| time.0).unwrap_or(f64::NAN);
                if (first - planned).abs() > 0.25 {
                    panic!("{label}: segment {unit} starts at {first:.3}, playlist says {planned:.3}");
                }
                Ok(())
            }
        };
        play(
            client,
            &id,
            episode,
            duration,
            count,
            move |time| lookup.partition_point(|start| *start <= time).saturating_sub(1),
            move |unit| unit_start[unit],
            fetch,
            &mut report,
            started,
        )
        .await;
    } else {
        let source = Arc::new(std::fs::read(&episode.source).unwrap());
        let chunk = 1024 * 1024usize;
        let count = source.len().div_ceil(chunk);
        let bytes_per_second = source.len() as f64 / duration;
        let http = client.http.clone();
        let url = client.media_url(&id, "stream");
        let fetch = move |unit: usize| {
            let http = http.clone();
            let url = url.clone();
            let source = source.clone();
            async move {
                let start = unit * chunk;
                let end = (start + chunk).min(source.len()) - 1;
                let response = http
                    .get(url)
                    .header("range", format!("bytes={start}-{end}"))
                    .send()
                    .await
                    .map_err(|error| error.to_string())?;
                if response.status().as_u16() != 206 {
                    return Err(format!("range {start}: HTTP {}", response.status()));
                }
                let bytes = response.bytes().await.map_err(|error| error.to_string())?;
                assert_eq!(&bytes[..], &source[start..=end], "direct bytes differ at {start}");
                Ok(())
            }
        };
        play(
            client,
            &id,
            episode,
            duration,
            count,
            move |time| ((time * bytes_per_second) as usize / chunk).min(count - 1),
            move |unit| (unit * chunk) as f64 / bytes_per_second,
            fetch,
            &mut report,
            started,
        )
        .await;
    }

    let (_, status) = client
        .json(reqwest::Method::GET, &format!("/v1/sessions/{id}"), None)
        .await;
    assert_eq!(status["phase"], "ready", "session degraded during playback: {status}");
    report.remux_restarts = status["remux"]["restarts"].as_u64().unwrap_or(0);
    // Auto-advance: leaving the episode closes its session.
    let (code, _) = client
        .json(reqwest::Method::DELETE, &format!("/v1/sessions/{id}"), None)
        .await;
    assert_eq!(code, 204);
    (report, ready)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
#[ignore = "long-running soak; run with `just soak`"]
async fn playback_soak() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "session=info,remux=info,warn".into()))
        .with_test_writer()
        .try_init();
    assert!(ffmpeg().is_some(), "the soak needs ffmpeg on PATH");
    let episode_seconds = env_f64("CUBO_SOAK_EPISODE_SECONDS", 1200.0) as u32;

    let root = std::env::temp_dir().join(format!("cubo-soak-{}", uuid::Uuid::new_v4()));
    let seed_root = root.join("seed");
    let pack = seed_root.join("Show.S01.1080p");
    std::fs::create_dir_all(&pack).unwrap();

    // A season pack (two episodes, picked by file index), an HEVC episode,
    // and a direct-play movie.
    let ep1 = fixture_long_mkv(FixtureSpec::default(), episode_seconds).expect("ep1 fixture");
    let ep2 = fixture_long_mkv(
        FixtureSpec { keyframe_every: 5.3, ..FixtureSpec::default() },
        episode_seconds,
    )
    .expect("ep2 fixture");
    let ep3 = fixture_long_mkv(
        FixtureSpec { hevc: true, keyframe_every: 4.1, ..FixtureSpec::default() },
        episode_seconds,
    )
    .expect("ep3 fixture");
    let movie = fixture_mp4(600).expect("movie fixture");
    let pack_ep1 = pack.join("Show.S01E01.mkv");
    let pack_ep2 = pack.join("Show.S01E02.mkv");
    std::fs::copy(&ep1, &pack_ep1).unwrap();
    std::fs::copy(&ep2, &pack_ep2).unwrap();
    let single_ep3 = seed_root.join("Show.S01E03.HEVC.mkv");
    std::fs::copy(&ep3, &single_ep3).unwrap();
    let single_movie = seed_root.join("Movie.2026.mp4");
    std::fs::copy(&movie, &single_movie).unwrap();

    // Throttle relative to the fastest fixture's bitrate at playback speed.
    let bitrate = [&pack_ep1, &pack_ep2, &single_ep3]
        .iter()
        .map(|path| std::fs::metadata(path).unwrap().len() as f64 / f64::from(episode_seconds))
        .chain([std::fs::metadata(&single_movie).unwrap().len() as f64 / 600.0])
        .fold(0.0, f64::max);
    let speed = env_f64("CUBO_SOAK_SPEED", 12.0);
    let upload_kbps = (bitrate * speed * env_f64("CUBO_SOAK_BANDWIDTH", 2.0) / 1024.0).ceil() as u32;
    eprintln!("soak: speed {speed}x, seeder capped at {upload_kbps} KB/s per torrent");
    let seeder = Session::new_with_opts(
        seed_root.clone(),
        SessionOptions {
            dht: None,
            disable_trackers: true,
            disable_local_service_discovery: true,
            persistence: None,
            listen: Some(librqbit::ListenerOptions {
                listen_addr: (std::net::Ipv4Addr::LOCALHOST, 0).into(),
                ..Default::default()
            }),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let pack_torrent = seed(&seeder, &pack, "Show.S01.1080p", upload_kbps).await;
    let ep3_torrent = seed(&seeder, &single_ep3, "Show.S01E03.HEVC.mkv", upload_kbps).await;
    let movie_torrent = seed(&seeder, &single_movie, "Movie.2026.mp4", upload_kbps).await;
    let peer = seeder.listen_addr().unwrap();

    // Budget smaller than two episodes: closed episodes must be evicted
    // while the live one is never touched.
    let episode_bytes = std::fs::metadata(&pack_ep1).unwrap().len();
    let core = spawn_test_core(&root.join("core"), episode_bytes * 3 / 2).await;
    let client = Client::new(&core);

    let mut episodes = vec![
        // Picked by filename (no index), like a pack Torrentio lists without fileIdx.
        Episode {
            label: "S01E01",
            magnet: pack_torrent.magnet.clone(),
            media_key: "tv:1:1:1".into(),
            file_index: None,
            expected_file: "Show.S01E01.mkv",
            source: pack_ep1.clone(),
            resume: 0.0,
            seeks: vec![
                (0.20, Seek::By(8.0)),
                (0.25, Seek::By(420.0)),
                (0.62, Seek::By(-300.0)),
                (0.70, Seek::To(0.93)),
            ],
        },
        // Same pack by explicit index (filled in after E01 reveals the order).
        Episode {
            label: "S01E02",
            magnet: pack_torrent.magnet.clone(),
            media_key: "tv:1:1:2".into(),
            file_index: None,
            expected_file: "Show.S01E02.mkv",
            source: pack_ep2.clone(),
            resume: 180.0,
            seeks: vec![(0.40, Seek::By(-20.0)), (0.55, Seek::To(0.80))],
        },
        Episode {
            label: "S01E03-hevc",
            magnet: ep3_torrent.magnet.clone(),
            media_key: "tv:1:1:3".into(),
            file_index: None,
            expected_file: "Show.S01E03.HEVC.mkv",
            source: single_ep3.clone(),
            resume: 0.0,
            seeks: vec![(0.50, Seek::By(120.0))],
        },
        Episode {
            label: "movie-direct",
            magnet: movie_torrent.magnet.clone(),
            media_key: "movie:1".into(),
            file_index: None,
            expected_file: "Movie.2026.mp4",
            source: single_movie.clone(),
            resume: 60.0,
            seeks: vec![(0.40, Seek::By(90.0)), (0.70, Seek::By(-150.0))],
        },
    ];

    let mut reports = Vec::new();
    let mut pack_hash: Option<String> = None;
    for position in 0..episodes.len() {
        let episode = &episodes[position];
        eprintln!("== {} ==", episode.label);
        let (report, ready) = watch_episode(&client, episode, peer).await;
        eprintln!("{}", serde_json::to_string(&report).unwrap());
        reports.push(report);
        if position == 0 {
            // The pack has two files; E02 is the other index.
            let first = ready["fileIndex"].as_u64().unwrap() as usize;
            episodes[1].file_index = Some(1 - first);
            pack_hash = ready["infoHash"].as_str().map(str::to_owned);
        }
        if position == 2 {
            // While E03 played, the closed pack pushed the cache over budget
            // and must have been evicted — the live file never is.
            let (_, cache) = client.json(reqwest::Method::GET, "/v1/cache", None).await;
            let cached: Vec<&str> = cache["entries"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|entry| entry["infoHash"].as_str())
                .collect();
            eprintln!("cache after E03: {} used of {} budget, entries {cached:?}", cache["usedBytes"], cache["maxBytes"]);
            assert!(
                !cached.contains(&pack_hash.as_deref().unwrap()),
                "closed season pack was not evicted under cache pressure"
            );
        }
    }

    eprintln!("\n=== soak summary ===");
    for report in &reports {
        eprintln!("{}", serde_json::to_string(report).unwrap());
    }
    for report in &reports {
        assert!(report.ready_ms < 30_000, "{}: slow start {} ms", report.label, report.ready_ms);
        assert!(
            report.max_stall_seconds < 5.0,
            "{}: stalled {:.1}s mid-playback",
            report.label,
            report.max_stall_seconds
        );
        assert!(report.stalls <= 3, "{}: {} stalls", report.label, report.stalls);
        for latency in &report.seek_latencies {
            assert!(*latency < 15.0, "{}: seek took {latency:.1}s", report.label);
        }
    }

    drop(core);
    seeder.stop().await;
    let _ = std::fs::remove_dir_all(&root);
}

/// Serves a real Core and a throttled local seeder for manual/browser
/// testing against fixture files, and writes `lab.json` (Core URL, token,
/// seeder address, magnets) next to them.
///
/// `CUBO_LAB_DIR=/path/with/mkvs cargo test -p cubo-engine browser_lab -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "interactive: serves fixture sessions for browser testing"]
async fn browser_lab() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "session=info,remux=info,warn".into()))
        .with_test_writer()
        .try_init();
    let dir = PathBuf::from(std::env::var("CUBO_LAB_DIR").expect("CUBO_LAB_DIR"));
    let minutes = env_f64("CUBO_LAB_MINUTES", 30.0);
    let upload_kbps = env_f64("CUBO_LAB_UPLOAD_KBPS", 400.0) as u32;
    let seeder = Session::new_with_opts(
        dir.clone(),
        SessionOptions {
            dht: None,
            disable_trackers: true,
            disable_local_service_discovery: true,
            persistence: None,
            listen: Some(librqbit::ListenerOptions {
                listen_addr: (std::net::Ipv4Addr::LOCALHOST, 0).into(),
                ..Default::default()
            }),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut magnets = serde_json::Map::new();
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| matches!(path.extension().and_then(|ext| ext.to_str()), Some("mkv" | "mp4")))
        .collect();
    files.sort();
    for file in &files {
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        let torrent = seed(&seeder, file, &name, upload_kbps).await;
        magnets.insert(name, Value::String(torrent.magnet));
    }
    let root = std::env::temp_dir().join(format!("cubo-lab-core-{}", uuid::Uuid::new_v4()));
    let core = spawn_test_core(&root, 20 * 1024 * 1024 * 1024).await;
    let lab = json!({
        "core": core.base_url,
        "token": core.token,
        "peer": seeder.listen_addr().unwrap(),
        "magnets": magnets,
    });
    std::fs::write(dir.join("lab.json"), serde_json::to_vec_pretty(&lab).unwrap()).unwrap();
    eprintln!("LAB {lab}");
    tokio::time::sleep(Duration::from_secs_f64(minutes * 60.0)).await;
}

/// A local seeder on loopback with DHT and trackers off.
async fn loopback_seeder(root: &Path) -> Arc<Session> {
    Session::new_with_opts(
        root.to_path_buf(),
        SessionOptions {
            dht: None,
            disable_trackers: true,
            disable_local_service_discovery: true,
            persistence: None,
            listen: Some(librqbit::ListenerOptions {
                listen_addr: (std::net::Ipv4Addr::LOCALHOST, 0).into(),
                ..Default::default()
            }),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

async fn open_session(client: &Client, body: Value) -> (Value, Duration) {
    let started = Instant::now();
    let (status, created) = client.json(reqwest::Method::POST, "/v1/sessions", Some(body)).await;
    assert_eq!(status, 201, "create session: {created}");
    let id = created["id"].as_str().unwrap().to_string();
    let ready = wait_ready(client, &id).await;
    (ready, started.elapsed())
}

/// Reopening a source Core already has must never wait on the swarm. With
/// DHT and trackers off and no peers passed, the only way these sessions
/// can start is from what Core kept: the managed torrent, or the saved
/// metadata plus the file on disk after a restart. rqbit resolves magnet
/// metadata from peers before checking what it manages, which used to hang
/// a reopened (already downloaded) source for the full resolve timeout.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reopening_a_downloaded_source_needs_no_swarm() {
    if ffmpeg().is_none() {
        eprintln!("skipping: needs ffmpeg on PATH");
        return;
    }
    let root = std::env::temp_dir().join(format!("cubo-reopen-{}", uuid::Uuid::new_v4()));
    let seed_root = root.join("seed");
    std::fs::create_dir_all(&seed_root).unwrap();
    let movie = seed_root.join("Movie.2026.mp4");
    std::fs::copy(fixture_mp4(30).expect("fixture"), &movie).unwrap();
    let seeder = loopback_seeder(&seed_root).await;
    let torrent = seed(&seeder, &movie, "Movie.2026.mp4", 100_000).await;
    let peer = seeder.listen_addr().unwrap();

    let core_root = root.join("core");
    let core = spawn_test_core(&core_root, 4 * 1024 * 1024 * 1024).await;
    let client = Client::new(&core);
    let (first, _) = open_session(
        &client,
        json!({ "magnet": torrent.magnet, "peers": [peer], "hevc": false }),
    )
    .await;
    let first_id = first["id"].as_str().unwrap();
    // Download the whole file, then close: the torrent stays managed, paused.
    let started = Instant::now();
    loop {
        let (_, status) = client
            .json(reqwest::Method::GET, &format!("/v1/sessions/{first_id}"), None)
            .await;
        if status["torrent"]["finished"].as_bool() == Some(true) {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(60), "download never finished: {status}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    client
        .json(reqwest::Method::DELETE, &format!("/v1/sessions/{first_id}"), None)
        .await;

    let hash = torrent.magnet.rsplit(':').next().unwrap();
    let piece_record = core_root.join("piece-state").join(format!("{hash}.bitv"));
    let saved = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(bytes) = std::fs::read(&piece_record) {
                if bytes.iter().any(|byte| *byte != 0) {
                    break true;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    assert!(matches!(saved, Ok(true)), "piece record was not persisted");

    let (ready, reopened) = open_session(&client, json!({ "magnet": torrent.magnet, "hevc": false })).await;
    assert!(reopened < Duration::from_secs(5), "reopen took {reopened:?}");

    // The whole file is on disk, so the player's download bar is full.
    let id = ready["id"].as_str().unwrap();
    let (status, beat) = client
        .json(
            reqwest::Method::POST,
            &format!("/v1/sessions/{id}/heartbeat"),
            Some(json!({ "positionSeconds": 1.0, "playing": true })),
        )
        .await;
    assert_eq!(status, 200, "heartbeat: {beat}");
    let ranges = beat["availableRanges"].as_array().expect("availableRanges");
    assert_eq!(ranges.len(), 1, "{beat}");
    let duration = ready["durationSeconds"].as_f64().unwrap();
    assert_eq!(ranges[0][0].as_f64(), Some(0.0));
    assert!((ranges[0][1].as_f64().unwrap() - duration).abs() < 0.01, "{beat}");

    // A fresh Core over the same data dir (rqbit forgets torrents on
    // restart) starts from the saved metadata and the file on disk.
    let restarted = spawn_test_core(&core_root, 4 * 1024 * 1024 * 1024).await;
    let restarted_client = Client::new(&restarted);
    let (_, after_restart) =
        open_session(&restarted_client, json!({ "magnet": torrent.magnet, "hevc": false })).await;
    assert!(after_restart < Duration::from_secs(10), "restart reopen took {after_restart:?}");
    let _ = std::fs::remove_dir_all(&root);
}

/// A prefetch warms probe and metadata, then parks the torrent; the session
/// that follows goes straight to ready.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn prefetched_source_starts_without_probing() {
    if ffmpeg().is_none() {
        eprintln!("skipping: needs ffmpeg on PATH");
        return;
    }
    let root = std::env::temp_dir().join(format!("cubo-prefetch-{}", uuid::Uuid::new_v4()));
    let seed_root = root.join("seed");
    std::fs::create_dir_all(&seed_root).unwrap();
    let movie = seed_root.join("Movie.2026.mp4");
    std::fs::copy(fixture_mp4(31).expect("fixture"), &movie).unwrap();
    let seeder = loopback_seeder(&seed_root).await;
    let torrent = seed(&seeder, &movie, "Movie.2026.mp4", 100_000).await;
    let peer = seeder.listen_addr().unwrap();

    let core = spawn_test_core(&root.join("core"), 4 * 1024 * 1024 * 1024).await;
    let client = Client::new(&core);
    let request = json!({ "magnet": torrent.magnet, "peers": [peer], "hevc": false });
    let (status, _) = client
        .json(reqwest::Method::POST, "/v1/prefetch", Some(request.clone()))
        .await;
    assert_eq!(status, 202);
    // Prefetch is fire-and-forget; give it time to warm up.
    tokio::time::sleep(Duration::from_secs(5)).await;

    let (ready, _) = open_session(&client, request).await;
    let timeline = &ready["timeline"];
    let probe_ms = timeline["probedMs"].as_u64().unwrap() - timeline["initializedMs"].as_u64().unwrap();
    assert!(probe_ms < 50, "session re-probed a prefetched source: {timeline}");
    let _ = std::fs::remove_dir_all(&root);
}

/// Some releases stop the picture before the container's duration while the
/// audio runs on. The playlist must end with the picture: a playlist longer
/// than it lists time no segment can fill, and a seek there loads forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn playlist_ends_where_the_picture_ends() {
    let Some(ffmpeg) = ffmpeg() else {
        eprintln!("skipping: needs ffmpeg on PATH");
        return;
    };
    let root = std::env::temp_dir().join(format!("cubo-short-video-{}", uuid::Uuid::new_v4()));
    let seed_root = root.join("seed");
    std::fs::create_dir_all(&seed_root).unwrap();
    let movie = seed_root.join("Movie.2026.mkv");
    let status = std::process::Command::new(ffmpeg)
        .args(["-v", "error", "-y"])
        .args(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=20"])
        .args(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=60"])
        .args(["-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48"])
        .args(["-c:a", "ac3"])
        .arg(&movie)
        .status()
        .unwrap();
    assert!(status.success());

    let seeder = loopback_seeder(&seed_root).await;
    let torrent = seed(&seeder, &movie, "Movie.2026.mkv", 100_000).await;
    let peer = seeder.listen_addr().unwrap();
    let core = spawn_test_core(&root.join("core"), 4 * 1024 * 1024 * 1024).await;
    let client = Client::new(&core);
    let (ready, _) = open_session(
        &client,
        json!({ "magnet": torrent.magnet, "peers": [peer], "hevc": false, "resumeSeconds": 55.0 }),
    )
    .await;
    let duration = ready["durationSeconds"].as_f64().unwrap();
    assert!((duration - 20.0).abs() < 0.5, "playlist should end with the picture: {ready}");

    // The final listed segment really holds picture up to that end.
    let id = ready["id"].as_str().unwrap();
    let playlist = client
        .http
        .get(client.media_url(id, "hls/media.m3u8"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let last = playlist
        .lines()
        .filter(|line| line.contains(".m4s"))
        .last()
        .unwrap()
        .split('?')
        .next()
        .unwrap()
        .to_string();
    let fetch = |file: String| {
        let url = client.media_url(id, &format!("hls/{file}"));
        let http = client.http.clone();
        async move { http.get(url).send().await.unwrap().bytes().await.unwrap() }
    };
    let init = fetch("init.mp4".into()).await;
    let segment = fetch(last).await;
    let times = fragment_times(&init, &segment, OUTPUT_TS_OFFSET);
    let end = times.iter().map(|(_, end)| *end).fold(0.0f64, f64::max);
    assert!((end - duration).abs() < 0.5, "last segment ends at {end}, playlist at {duration}");
    let _ = std::fs::remove_dir_all(&root);
}
