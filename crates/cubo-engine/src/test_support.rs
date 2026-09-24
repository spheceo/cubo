//! Shared helpers for tests that need real media: fixture files generated
//! with the local ffmpeg (cached between runs) and fMP4 segment inspection.

use std::path::PathBuf;
use std::process::Command;

use crate::fmp4::{Fmp4Event, Fmp4Splitter};
use crate::transcode::find_tool;

#[derive(Clone, Copy)]
pub struct FixtureSpec {
    pub seconds: u32,
    /// Seconds between forced keyframes (irregular spacing on purpose).
    pub keyframe_every: f32,
    pub b_frames: bool,
    pub hevc: bool,
    pub width: u32,
}

impl Default for FixtureSpec {
    fn default() -> Self {
        Self {
            seconds: 120,
            keyframe_every: 3.7,
            b_frames: true,
            hevc: false,
            width: 320,
        }
    }
}

pub fn ffmpeg() -> Option<PathBuf> {
    find_tool("ffmpeg")
}

/// Generates (once) an MKV with test video and 5.1 E-AC3 audio — the shape
/// of a typical WEB-DL episode, at a tiny resolution.
pub fn fixture_mkv(spec: FixtureSpec) -> Option<PathBuf> {
    let ffmpeg = ffmpeg()?;
    let dir = std::env::temp_dir().join("cubo-fixtures");
    std::fs::create_dir_all(&dir).ok()?;
    let name = format!(
        "fx-{}s-k{}-b{}-{}-{}.mkv",
        spec.seconds,
        spec.keyframe_every,
        u8::from(spec.b_frames),
        if spec.hevc { "hevc" } else { "avc" },
        spec.width
    );
    let path = dir.join(name);
    if path.is_file() {
        return Some(path);
    }
    let temp = path.with_extension("tmp.mkv");
    let height = spec.width * 9 / 16 / 2 * 2;
    let codec: &[&str] = if spec.hevc {
        &["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error"]
    } else {
        &["-c:v", "libx264", "-preset", "veryfast"]
    };
    let status = Command::new(ffmpeg)
        .args(["-v", "error", "-y"])
        .args(["-f", "lavfi", "-i", &format!("testsrc2=size={}x{height}:rate=24000/1001", spec.width)])
        .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"])
        .args(["-t", &spec.seconds.to_string()])
        .args(["-map", "0:v", "-map", "1:a"])
        .args(codec)
        .args(["-bf", if spec.b_frames { "3" } else { "0" }])
        .args(["-g", "600"])
        .args(["-force_key_frames", &format!("expr:gte(t,n_forced*{})", spec.keyframe_every)])
        .args(["-c:a", "eac3", "-ac", "6", "-b:a", "256k"])
        .arg(&temp)
        .status()
        .ok()?;
    if !status.success() {
        return None;
    }
    std::fs::rename(&temp, &path).ok()?;
    Some(path)
}

/// Video fragment decode times (seconds, offset removed) inside a segment.
pub fn fragment_times(init: &[u8], segment: &[u8], offset: f64) -> Vec<(f64, f64)> {
    let mut splitter = Fmp4Splitter::new();
    let mut times = Vec::new();
    for event in splitter
        .push(init)
        .unwrap()
        .into_iter()
        .chain(splitter.push(segment).unwrap())
    {
        if let Fmp4Event::Fragment(fragment) = event {
            times.push((fragment.video_start - offset, fragment.video_end - offset));
        }
    }
    times
}

/// Repeats a generated clip end to end (stream copy, continuous timestamps)
/// to build a long episode in seconds instead of encoding it.
pub fn fixture_long_mkv(spec: FixtureSpec, total_seconds: u32) -> Option<PathBuf> {
    let base = fixture_mkv(spec)?;
    if total_seconds <= spec.seconds {
        return Some(base);
    }
    let path = base.with_file_name(format!(
        "{}-x{}.mkv",
        base.file_stem()?.to_string_lossy(),
        total_seconds
    ));
    if path.is_file() {
        return Some(path);
    }
    let repeats = total_seconds.div_ceil(spec.seconds);
    let list = path.with_extension("txt");
    let line = format!("file '{}'\n", base.display());
    std::fs::write(&list, line.repeat(repeats as usize)).ok()?;
    let temp = path.with_extension("tmp.mkv");
    let status = Command::new(ffmpeg()?)
        .args(["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i"])
        .arg(&list)
        .args(["-t", &total_seconds.to_string(), "-c", "copy"])
        .arg(&temp)
        .status()
        .ok()?;
    let _ = std::fs::remove_file(&list);
    if !status.success() {
        return None;
    }
    std::fs::rename(&temp, &path).ok()?;
    Some(path)
}

/// A direct-play MP4 (H.264 + AAC, moov up front).
pub fn fixture_mp4(seconds: u32) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join("cubo-fixtures");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("fx-direct-{seconds}s.mp4"));
    if path.is_file() {
        return Some(path);
    }
    let temp = path.with_extension("tmp.mp4");
    let status = Command::new(ffmpeg()?)
        .args(["-v", "error", "-y"])
        .args(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24"])
        .args(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000"])
        .args(["-t", &seconds.to_string(), "-map", "0:v", "-map", "1:a"])
        .args(["-c:v", "libx264", "-preset", "ultrafast", "-g", "96"])
        .args(["-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"])
        .arg(&temp)
        .status()
        .ok()?;
    if !status.success() {
        return None;
    }
    std::fs::rename(&temp, &path).ok()?;
    Some(path)
}
