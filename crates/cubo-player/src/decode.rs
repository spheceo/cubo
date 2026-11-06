//! Decoding runs in ffmpeg sidecar processes, as in Cubo Core: the static
//! ffmpeg builds are GPL, so Cubo runs them and never links them.
//!
//! Video comes out as raw NV12 frames at a constant rate and audio as
//! interleaved f32 stereo, both starting exactly at the requested position
//! (ffmpeg's accurate seek), so frame `n` is at `start + n / fps` and the
//! audio clock is `start + samples / rate`. Progressive video decodes on
//! the Mac's VideoToolbox; ffmpeg falls back to software where VideoToolbox
//! refuses (interlaced H.264), and interlaced frames are deinterlaced
//! (yadif) on the way out.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use crossbeam_channel::{Receiver, Sender};
use serde::Deserialize;

pub fn find_tool(name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
            // Cubo Player.app/Contents/MacOS → Contents/Resources
            candidates.push(dir.join("../Resources").join(name));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(Path::new(&home).join(".local/bin").join(name));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin").join(name));
    candidates.push(PathBuf::from("/usr/local/bin").join(name));
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(name)));
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[derive(Debug, Clone)]
pub struct MediaInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// Display aspect ratio (sample aspect applied).
    pub aspect: f64,
    pub interlaced: bool,
    pub duration: Option<f64>,
    pub video_codec: String,
    /// Absolute stream index of the first audio stream.
    pub first_audio: Option<u32>,
}

#[derive(Deserialize)]
struct Probe {
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

#[derive(Deserialize)]
struct ProbeStream {
    index: u32,
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    field_order: Option<String>,
    sample_aspect_ratio: Option<String>,
    #[serde(default)]
    disposition: std::collections::HashMap<String, i32>,
}

fn ratio(value: Option<&str>) -> Option<f64> {
    let (num, den) = value?.split_once(['/', ':'])?;
    let num: f64 = num.parse().ok()?;
    let den: f64 = den.parse().ok()?;
    (num > 0.0 && den > 0.0).then_some(num / den)
}

pub fn probe(ffprobe: &Path, url: &str) -> Result<MediaInfo> {
    let output = Command::new(ffprobe)
        .args(["-v", "error", "-show_streams", "-show_format", "-of", "json", url])
        .stdin(Stdio::null())
        .output()
        .context("could not run ffprobe")?;
    if !output.status.success() {
        bail!("ffprobe failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    let probe: Probe = serde_json::from_slice(&output.stdout)?;
    let video = probe
        .streams
        .iter()
        .find(|stream| {
            stream.codec_type.as_deref() == Some("video")
                && stream.disposition.get("attached_pic").copied().unwrap_or(0) == 0
        })
        .ok_or_else(|| anyhow!("the file has no video"))?;
    let width = video.width.unwrap_or(0) & !1;
    let height = video.height.unwrap_or(0) & !1;
    if width == 0 || height == 0 {
        bail!("the video has no size");
    }
    let fps = ratio(video.avg_frame_rate.as_deref())
        .or_else(|| ratio(video.r_frame_rate.as_deref()))
        .filter(|fps| (5.0..=120.0).contains(fps))
        .unwrap_or(24.0);
    let sar = ratio(video.sample_aspect_ratio.as_deref()).unwrap_or(1.0);
    let interlaced = matches!(video.field_order.as_deref(), Some("tt" | "bb" | "tb" | "bt"));
    Ok(MediaInfo {
        width,
        height,
        fps,
        aspect: width as f64 * sar / height as f64,
        interlaced,
        duration: probe.format.and_then(|format| format.duration?.parse().ok()),
        video_codec: video.codec_name.clone().unwrap_or_default(),
        first_audio: probe
            .streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some("audio"))
            .map(|stream| stream.index),
    })
}

pub struct Frame {
    pub pts: f64,
    pub data: Vec<u8>,
}

/// A running decoder; dropping it stops the ffmpeg process.
pub struct Decoder {
    child: Child,
    stop: Arc<AtomicBool>,
}

impl Drop for Decoder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn base_command(ffmpeg: &Path, url: &str, start: f64) -> Command {
    let mut command = Command::new(ffmpeg);
    command.args(["-nostdin", "-v", "error", "-hide_banner"]);
    command.args(["-hwaccel", "videotoolbox"]);
    if start > 0.0 {
        command.args(["-ss", &format!("{start:.3}")]);
    }
    command.args(["-i", url]);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    command
}

/// Decodes video from `start`; frames arrive on the returned channel and
/// the channel closes at the end of the file.
pub fn video(ffmpeg: &Path, url: &str, start: f64, info: &MediaInfo) -> Result<(Decoder, Receiver<Frame>)> {
    let mut filters = Vec::new();
    if info.interlaced {
        filters.push("yadif=mode=send_frame:deint=interlaced".to_string());
    }
    filters.push(format!("scale={}:{}", info.width, info.height));
    filters.push("format=nv12".into());
    let mut command = base_command(ffmpeg, url, start);
    command
        .args(["-map", "0:v:0", "-an", "-sn", "-dn"])
        .args(["-vf", &filters.join(",")])
        .args(["-fps_mode", "cfr", "-r", &format!("{}", info.fps)])
        .args(["-f", "rawvideo", "pipe:1"]);
    let mut child = command.spawn().context("could not start ffmpeg")?;
    let mut stdout = child.stdout.take().ok_or_else(|| anyhow!("ffmpeg has no stdout"))?;
    let (sender, receiver): (Sender<Frame>, Receiver<Frame>) = crossbeam_channel::bounded(6);
    let stop = Arc::new(AtomicBool::new(false));
    let frame_bytes = (info.width * info.height * 3 / 2) as usize;
    let fps = info.fps;
    let flag = stop.clone();
    std::thread::Builder::new().name("video-decode".into()).spawn(move || {
        let mut index = 0u64;
        loop {
            let mut data = vec![0u8; frame_bytes];
            if stdout.read_exact(&mut data).is_err() || flag.load(Ordering::Relaxed) {
                return;
            }
            let frame = Frame { pts: start + index as f64 / fps, data };
            index += 1;
            if sender.send(frame).is_err() {
                return;
            }
        }
    })?;
    Ok((Decoder { child, stop }, receiver))
}

/// Decodes audio from `start` as interleaved f32 stereo at `rate`, handing
/// each block to `sink` (which blocks while the output buffer is full).
/// `done` is set when the file ends.
pub fn audio(
    ffmpeg: &Path,
    url: &str,
    start: f64,
    stream: u32,
    rate: u32,
    mut sink: impl FnMut(&[f32]) -> bool + Send + 'static,
    done: Arc<AtomicBool>,
) -> Result<Decoder> {
    let mut command = base_command(ffmpeg, url, start);
    command
        .args(["-map", &format!("0:{stream}"), "-vn", "-sn", "-dn"])
        .args(["-ac", "2", "-ar", &rate.to_string()])
        .args(["-f", "f32le", "pipe:1"]);
    let mut child = command.spawn().context("could not start ffmpeg")?;
    let mut stdout = child.stdout.take().ok_or_else(|| anyhow!("ffmpeg has no stdout"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::Builder::new().name("audio-decode".into()).spawn(move || {
        let mut bytes = vec![0u8; 4096 * 8];
        let mut samples = vec![0f32; 4096 * 2];
        loop {
            if stdout.read_exact(&mut bytes).is_err() || flag.load(Ordering::Relaxed) {
                // A short final block is dropped: at most 85 ms of the end.
                if !flag.load(Ordering::Relaxed) {
                    done.store(true, Ordering::Relaxed);
                }
                return;
            }
            for (sample, raw) in samples.iter_mut().zip(bytes.chunks_exact(4)) {
                *sample = f32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]);
            }
            if !sink(&samples) {
                return;
            }
        }
    })?;
    Ok(Decoder { child, stop })
}
