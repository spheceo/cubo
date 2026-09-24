//! Incremental splitter for ffmpeg's fragmented-MP4 output.
//!
//! ffmpeg writes one continuous fMP4 stream per remux job (`frag_keyframe`,
//! so every fragment starts on a video keyframe). This module cuts that byte
//! stream into the init segment (`ftyp` + `moov`) and self-contained
//! fragments (`moof` + `mdat`), and reads each fragment's video decode time
//! so the session can file it under the right planned HLS segment.

use bytes::{Buf, Bytes, BytesMut};

#[derive(Debug)]
pub enum Fmp4Event {
    Init(Bytes),
    Fragment(Fragment),
}

#[derive(Debug, Clone)]
pub struct Fragment {
    /// `moof` + `mdat` (plus any box ffmpeg put between them).
    pub bytes: Bytes,
    /// Decode time of the fragment's first video sample, in seconds on the
    /// output timeline (before the caller removes its timestamp offset).
    pub video_start: f64,
    /// `video_start` plus the summed durations of the video samples.
    pub video_end: f64,
}

#[derive(Debug, Clone, Copy, Default)]
struct TrackInfo {
    id: u32,
    timescale: u32,
    is_video: bool,
    default_duration: u32,
}

#[derive(Default)]
pub struct Fmp4Splitter {
    buffer: BytesMut,
    init: Vec<u8>,
    init_done: bool,
    tracks: Vec<TrackInfo>,
    /// Boxes of the fragment being collected (from `moof` onwards).
    fragment: Vec<u8>,
    fragment_times: Option<(f64, f64)>,
}

/// Upper bound for a single box. A 10 s GOP of 4K HEVC stays far below this;
/// anything bigger is a corrupt stream, not a fragment.
const MAX_BOX: u64 = 512 * 1024 * 1024;

impl Fmp4Splitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends bytes read from ffmpeg and returns every completed event.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Fmp4Event>, String> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some((kind, size)) = peek_box(&self.buffer)? {
            if (self.buffer.len() as u64) < size {
                break;
            }
            let data = self.buffer.split_to(size as usize).freeze();
            self.accept(kind, data, &mut events)?;
        }
        Ok(events)
    }

    fn accept(&mut self, kind: [u8; 4], data: Bytes, events: &mut Vec<Fmp4Event>) -> Result<(), String> {
        if !self.init_done {
            if &kind == b"moof" {
                if self.tracks.is_empty() {
                    return Err("fragment arrived before the movie header".into());
                }
                self.init_done = true;
                events.push(Fmp4Event::Init(Bytes::from(std::mem::take(&mut self.init))));
            } else {
                if &kind == b"moov" {
                    self.tracks = parse_moov(&data[8..])?;
                }
                self.init.extend_from_slice(&data);
                return Ok(());
            }
        }
        match &kind {
            b"moof" => {
                if !self.fragment.is_empty() {
                    return Err("fragment is missing its media data".into());
                }
                self.fragment_times = Some(self.video_times(&data[8..])?);
                self.fragment.extend_from_slice(&data);
            }
            b"mdat" => {
                let Some((video_start, video_end)) = self.fragment_times.take() else {
                    // Media data outside a fragment carries nothing we can place.
                    return Ok(());
                };
                self.fragment.extend_from_slice(&data);
                events.push(Fmp4Event::Fragment(Fragment {
                    bytes: Bytes::from(std::mem::take(&mut self.fragment)),
                    video_start,
                    video_end,
                }));
            }
            _ => {
                if !self.fragment.is_empty() {
                    self.fragment.extend_from_slice(&data);
                }
            }
        }
        Ok(())
    }

    fn video_times(&self, moof: &[u8]) -> Result<(f64, f64), String> {
        let video = self
            .tracks
            .iter()
            .find(|track| track.is_video)
            .ok_or("output has no video track")?;
        for (kind, traf) in boxes(moof) {
            if &kind != b"traf" {
                continue;
            }
            let mut track_id = 0;
            let mut default_duration = video.default_duration;
            let mut decode_time = None;
            let mut total = 0u64;
            for (inner, body) in boxes(traf) {
                match &inner {
                    b"tfhd" => {
                        let (id, duration) = parse_tfhd(body)?;
                        track_id = id;
                        if let Some(duration) = duration {
                            default_duration = duration;
                        }
                    }
                    b"tfdt" => decode_time = Some(parse_tfdt(body)?),
                    b"trun" => {
                        total += parse_trun_duration(body, default_duration)?;
                    }
                    _ => {}
                }
            }
            if track_id != video.id {
                continue;
            }
            let decode_time = decode_time.ok_or("video fragment has no decode time")?;
            let timescale = f64::from(video.timescale.max(1));
            let start = decode_time as f64 / timescale;
            return Ok((start, start + total as f64 / timescale));
        }
        Err("fragment carries no video samples".into())
    }
}

fn peek_box(buffer: &[u8]) -> Result<Option<([u8; 4], u64)>, String> {
    if buffer.len() < 8 {
        return Ok(None);
    }
    let size32 = u32::from_be_bytes(buffer[0..4].try_into().unwrap());
    let kind: [u8; 4] = buffer[4..8].try_into().unwrap();
    let size = match size32 {
        0 => return Err("unbounded box in a streamed fMP4".into()),
        1 => {
            if buffer.len() < 16 {
                return Ok(None);
            }
            u64::from_be_bytes(buffer[8..16].try_into().unwrap())
        }
        size => u64::from(size),
    };
    if size < 8 || size > MAX_BOX {
        return Err(format!("implausible fMP4 box size {size}"));
    }
    Ok(Some((kind, size)))
}

/// Iterates child boxes of a fully buffered container body.
fn boxes(body: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    let mut offset = 0usize;
    std::iter::from_fn(move || {
        let rest = body.get(offset..)?;
        if rest.len() < 8 {
            return None;
        }
        let size32 = u32::from_be_bytes(rest[0..4].try_into().ok()?) as usize;
        let kind: [u8; 4] = rest[4..8].try_into().ok()?;
        let (header, size) = match size32 {
            1 => {
                let large = u64::from_be_bytes(rest.get(8..16)?.try_into().ok()?) as usize;
                (16, large)
            }
            0 => (8, rest.len()),
            size => (8, size),
        };
        if size < header || size > rest.len() {
            return None;
        }
        offset += size;
        Some((kind, &rest[header..size]))
    })
}

fn parse_moov(moov: &[u8]) -> Result<Vec<TrackInfo>, String> {
    let mut tracks = Vec::new();
    let mut defaults: Vec<(u32, u32)> = Vec::new();
    for (kind, body) in boxes(moov) {
        match &kind {
            b"trak" => tracks.push(parse_trak(body)?),
            b"mvex" => {
                for (inner, trex) in boxes(body) {
                    if &inner == b"trex" && trex.len() >= 16 {
                        let mut reader = &trex[4..];
                        let id = reader.get_u32();
                        let _description = reader.get_u32();
                        let duration = reader.get_u32();
                        defaults.push((id, duration));
                    }
                }
            }
            _ => {}
        }
    }
    for track in &mut tracks {
        if let Some((_, duration)) = defaults.iter().find(|(id, _)| *id == track.id) {
            track.default_duration = *duration;
        }
    }
    if tracks.is_empty() {
        return Err("movie header lists no tracks".into());
    }
    Ok(tracks)
}

fn parse_trak(trak: &[u8]) -> Result<TrackInfo, String> {
    let mut info = TrackInfo::default();
    for (kind, body) in boxes(trak) {
        match &kind {
            b"tkhd" => {
                let version = *body.first().ok_or("empty track header")?;
                let at = if version == 1 { 20 } else { 12 };
                info.id = read_u32(body, at)?;
            }
            b"mdia" => {
                for (inner, value) in boxes(body) {
                    match &inner {
                        b"mdhd" => {
                            let version = *value.first().ok_or("empty media header")?;
                            let at = if version == 1 { 20 } else { 12 };
                            info.timescale = read_u32(value, at)?;
                        }
                        b"hdlr" => {
                            info.is_video = value.get(8..12) == Some(b"vide");
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(info)
}

fn read_u32(bytes: &[u8], at: usize) -> Result<u32, String> {
    bytes
        .get(at..at + 4)
        .map(|value| u32::from_be_bytes(value.try_into().unwrap()))
        .ok_or_else(|| "truncated MP4 box".to_string())
}

/// Returns the track id and, when present, the default sample duration.
fn parse_tfhd(body: &[u8]) -> Result<(u32, Option<u32>), String> {
    let flags = read_u32(body, 0)? & 0x00FF_FFFF;
    let id = read_u32(body, 4)?;
    let mut at = 8;
    if flags & 0x1 != 0 {
        at += 8;
    }
    if flags & 0x2 != 0 {
        at += 4;
    }
    let duration = if flags & 0x8 != 0 {
        Some(read_u32(body, at)?)
    } else {
        None
    };
    Ok((id, duration))
}

fn parse_tfdt(body: &[u8]) -> Result<u64, String> {
    let version = *body.first().ok_or("empty tfdt")?;
    if version == 1 {
        body.get(4..12)
            .map(|value| u64::from_be_bytes(value.try_into().unwrap()))
            .ok_or_else(|| "truncated tfdt".to_string())
    } else {
        read_u32(body, 4).map(u64::from)
    }
}

fn parse_trun_duration(body: &[u8], default_duration: u32) -> Result<u64, String> {
    let flags = read_u32(body, 0)? & 0x00FF_FFFF;
    let count = read_u32(body, 4)? as usize;
    let mut at = 8;
    if flags & 0x1 != 0 {
        at += 4;
    }
    if flags & 0x4 != 0 {
        at += 4;
    }
    let has_duration = flags & 0x100 != 0;
    let stride = [0x100, 0x200, 0x400, 0x800]
        .iter()
        .filter(|bit| flags & **bit != 0)
        .count()
        * 4;
    if !has_duration {
        return Ok(default_duration as u64 * count as u64);
    }
    let mut total = 0u64;
    for index in 0..count {
        total += u64::from(read_u32(body, at + index * stride)?);
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs ffmpeg's real output through the splitter when a fixture is given:
    /// `CUBO_FMP4_FIXTURE=/tmp/out.mp4 cargo test -p cubo-engine fmp4_fixture -- --ignored`
    #[test]
    #[ignore = "needs CUBO_FMP4_FIXTURE"]
    fn fmp4_fixture_splits() {
        let path = std::env::var("CUBO_FMP4_FIXTURE").expect("CUBO_FMP4_FIXTURE");
        let bytes = std::fs::read(path).unwrap();
        let mut splitter = Fmp4Splitter::new();
        let mut events = Vec::new();
        // Odd chunk sizes exercise box reassembly.
        for chunk in bytes.chunks(7919) {
            events.extend(splitter.push(chunk).unwrap());
        }
        let mut total = 0;
        for event in &events {
            match event {
                Fmp4Event::Init(init) => {
                    eprintln!("init {} bytes", init.len());
                    total += init.len();
                }
                Fmp4Event::Fragment(fragment) => {
                    eprintln!("fragment {:.3}..{:.3} {} bytes", fragment.video_start, fragment.video_end, fragment.bytes.len());
                    total += fragment.bytes.len();
                }
            }
        }
        assert_eq!(total, bytes.len(), "every byte lands in init or a fragment");
    }

    #[test]
    fn rejects_garbage_sizes() {
        let mut splitter = Fmp4Splitter::new();
        assert!(splitter.push(&[0, 0, 0, 2, b'f', b't', b'y', b'p']).is_err());
    }
}
