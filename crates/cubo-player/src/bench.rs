//! Benchmark recording: startup, stalls and a once-a-second timeline, in
//! the same JSON shape as `scripts/bench/browser-run.ts` writes for the
//! browser, so the two clients compare directly.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::cache::Cache;

pub struct Bench {
    pub started_at: Instant,
    playing_at: Mutex<Option<Duration>>,
    stall: Mutex<Option<(Instant, f64)>>,
    stalls: Mutex<Vec<Value>>,
    timeline: Mutex<Vec<Value>>,
    /// Current media position (f64 bits) and whether a stall is on, for the
    /// sampler thread.
    position: AtomicU64,
    stalled: AtomicBool,
    /// Playing (not paused, buffering or ended), for progress reports.
    pub playing: AtomicBool,
    pub enabled: bool,
}

impl Bench {
    pub fn new(started_at: Instant, enabled: bool) -> Arc<Self> {
        Arc::new(Self {
            started_at,
            playing_at: Mutex::new(None),
            stall: Mutex::new(None),
            stalls: Mutex::new(Vec::new()),
            timeline: Mutex::new(Vec::new()),
            position: AtomicU64::new(0),
            stalled: AtomicBool::new(false),
            playing: AtomicBool::new(false),
            enabled,
        })
    }

    pub fn playing(&self) {
        let mut playing = self.playing_at.lock().unwrap();
        if playing.is_none() {
            *playing = Some(self.started_at.elapsed());
            eprintln!("cubo-player: playing after {} ms", self.started_at.elapsed().as_millis());
        }
    }

    pub fn stall_started(&self, position: f64) {
        self.stalled.store(true, Ordering::Relaxed);
        *self.stall.lock().unwrap() = Some((Instant::now(), position));
    }

    pub fn stall_ended(&self) {
        self.stalled.store(false, Ordering::Relaxed);
        if let Some((at, position)) = self.stall.lock().unwrap().take() {
            let ms = at.elapsed().as_millis() as u64;
            eprintln!("cubo-player: stall at {position:.1}s for {ms} ms");
            self.stalls.lock().unwrap().push(json!({
                "at_position": position,
                "started_at_s": (at - self.started_at).as_secs_f64(),
                "ms": ms,
            }));
        }
    }

    pub fn set_position(&self, position: f64) {
        self.position.store(position.to_bits(), Ordering::Relaxed);
    }

    pub fn position(&self) -> f64 {
        f64::from_bits(self.position.load(Ordering::Relaxed))
    }

    /// Samples the timeline once a second until the process exits.
    pub fn start_sampler(self: &Arc<Self>, cache: Arc<Cache>, duration: f64, core_pid: Option<u32>) {
        if !self.enabled {
            return;
        }
        let bench = Arc::clone(self);
        std::thread::spawn(move || {
            let bytes_per_second = cache.size as f64 / duration.max(1.0);
            let mut last_bytes = cache.downloaded.load(Ordering::Relaxed);
            let mut last_at = Instant::now();
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let position = bench.position();
                let offset = cache.read_offset.load(Ordering::Relaxed);
                let ahead = cache.contiguous_from(offset) as f64 / bytes_per_second;
                let bytes = cache.downloaded.load(Ordering::Relaxed);
                let elapsed = last_at.elapsed().as_secs_f64();
                let mbps = (bytes - last_bytes) as f64 * 8.0 / 1e6 / elapsed;
                last_bytes = bytes;
                last_at = Instant::now();
                let (client, core) = cpu_usage(std::process::id(), core_pid);
                bench.timeline.lock().unwrap().push(json!({
                    "t": bench.started_at.elapsed().as_secs_f64(),
                    "position": position,
                    "buffer_ahead_s": ahead,
                    "link_mbps": mbps,
                    "core_cpu": core,
                    "client_cpu": client,
                    "stalled": bench.stalled.load(Ordering::Relaxed),
                }));
            }
        });
    }

    pub fn write(&self, path: &PathBuf, label: &str, start: f64, link_mbps: f64, bytes_down: u64, core_version: &str) {
        if self.stalled.load(Ordering::Relaxed) {
            self.stall_ended();
        }
        let stalls = self.stalls.lock().unwrap().clone();
        let timeline = self.timeline.lock().unwrap().clone();
        let average = |key: &str| {
            let values: Vec<f64> = timeline.iter().filter_map(|row| row[key].as_f64()).collect();
            if values.is_empty() { 0.0 } else { values.iter().sum::<f64>() / values.len() as f64 }
        };
        let result = json!({
            "label": label,
            "client": "native",
            "core_version": core_version,
            "link_mbps": link_mbps,
            "wall_seconds": self.started_at.elapsed().as_secs_f64(),
            "start_position": start,
            "startup_ms": self.playing_at.lock().unwrap().map(|at| at.as_millis() as u64),
            "stall_count": stalls.len(),
            "stall_ms_total": stalls.iter().filter_map(|stall| stall["ms"].as_u64()).sum::<u64>(),
            "stalls": stalls,
            "played_seconds": self.position() - start,
            "bytes_down": bytes_down,
            "core_cpu_avg": average("core_cpu"),
            "client_cpu_avg": average("client_cpu"),
            "timeline": timeline,
        });
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::write(path, serde_json::to_string_pretty(&result).unwrap()) {
            Ok(()) => eprintln!("cubo-player: wrote {}", path.display()),
            Err(error) => eprintln!("cubo-player: could not write {}: {error}", path.display()),
        }
    }
}

/// CPU percent (of one core) of this process plus its ffmpeg children, and
/// of the Core process plus its children.
fn cpu_usage(own: u32, core: Option<u32>) -> (f64, f64) {
    let Ok(output) = Command::new("ps").args(["-A", "-o", "pid=,ppid=,%cpu="]).output() else {
        return (0.0, 0.0);
    };
    let rows: Vec<(u32, u32, f64)> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
        })
        .collect();
    let tree = |root: u32| -> f64 {
        rows.iter().filter(|(pid, ppid, _)| *pid == root || *ppid == root).map(|(_, _, cpu)| cpu).sum()
    };
    (tree(own), core.map_or(0.0, tree))
}
