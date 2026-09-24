//! Where each moment of an MP4 lives in the file.
//!
//! Reads the video track's sample tables from `moov` (at the start or the end
//! of the file) and returns one `(seconds, byte offset)` point per keyframe.
//! Core maps downloaded torrent pieces through it to tell the player which
//! stretches of the movie are on disk — browsers only know bytes and assume
//! a constant bitrate, which draws the buffered bar minutes off.

use crate::mkv_index::ByteSource;

/// `moov` for a feature film is a few MB; anything this big is corrupt.
const MAX_MOOV: u64 = 96 * 1024 * 1024;
/// Without a sync-sample table every sample is a keyframe; keep one point
/// per this many samples.
const SAMPLES_PER_POINT: usize = 24;

/// Ascending by time: `(seconds, absolute byte offset in the file)`.
pub type ByteMap = Vec<(f64, u64)>;

fn be_u32(bytes: &[u8], at: usize) -> Result<u32, String> {
    bytes
        .get(at..at + 4)
        .map(|slice| u32::from_be_bytes(slice.try_into().unwrap()))
        .ok_or_else(|| "truncated MP4 box".to_string())
}

fn be_u64(bytes: &[u8], at: usize) -> Result<u64, String> {
    bytes
        .get(at..at + 8)
        .map(|slice| u64::from_be_bytes(slice.try_into().unwrap()))
        .ok_or_else(|| "truncated MP4 box".to_string())
}

/// Child boxes of a container body: `(kind, body)`.
fn boxes(body: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at + 8 <= body.len() {
        let size32 = u32::from_be_bytes(body[at..at + 4].try_into().unwrap()) as u64;
        let kind: [u8; 4] = body[at + 4..at + 8].try_into().unwrap();
        let (header, size) = match size32 {
            0 => (8, (body.len() - at) as u64),
            1 => match be_u64(body, at + 8) {
                Ok(size) => (16, size),
                Err(_) => break,
            },
            size => (8, size),
        };
        if size < header as u64 || at as u64 + size > body.len() as u64 {
            break;
        }
        out.push((kind, &body[at + header..at + size as usize]));
        at += size as usize;
    }
    out
}

fn child<'a>(body: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(body).into_iter().find(|(found, _)| found == kind).map(|(_, body)| body)
}

/// Finds the top-level `moov` by walking box headers (skipping `mdat`).
async fn read_moov<S: ByteSource>(source: &S) -> Result<Vec<u8>, String> {
    let len = source.len();
    let mut at = 0u64;
    while at + 8 <= len {
        let head = source.read_at(at, 16.min(len - at)).await?;
        let size32 = be_u32(&head, 0)? as u64;
        let kind = &head[4..8];
        let (header, size) = match size32 {
            0 => (8, len - at),
            1 => (16, be_u64(&head, 8)?),
            size => (8, size),
        };
        if size < header {
            return Err("corrupt MP4 box header".into());
        }
        if kind == b"moov" {
            if size > MAX_MOOV || at + size > len {
                return Err("MP4 moov box is implausibly large".into());
            }
            return source.read_at(at + header, size - header).await;
        }
        at += size;
    }
    Err("MP4 has no moov box".into())
}

struct VideoTables<'a> {
    timescale: u32,
    stts: &'a [u8],
    stss: Option<&'a [u8]>,
    stsz: &'a [u8],
    stsc: &'a [u8],
    chunk_offsets: Vec<u64>,
}

fn video_tables(moov: &[u8]) -> Result<VideoTables<'_>, String> {
    for (kind, trak) in boxes(moov) {
        if &kind != b"trak" {
            continue;
        }
        let Some(mdia) = child(trak, b"mdia") else { continue };
        let is_video = child(mdia, b"hdlr").is_some_and(|hdlr| hdlr.get(8..12) == Some(b"vide"));
        if !is_video {
            continue;
        }
        let mdhd = child(mdia, b"mdhd").ok_or("video track has no mdhd")?;
        let timescale = if mdhd.first() == Some(&1) { be_u32(mdhd, 20)? } else { be_u32(mdhd, 12)? };
        let stbl = child(mdia, b"minf")
            .and_then(|minf| child(minf, b"stbl"))
            .ok_or("video track has no sample table")?;
        let chunk_offsets = if let Some(stco) = child(stbl, b"stco") {
            let count = be_u32(stco, 4)? as usize;
            (0..count)
                .map(|index| be_u32(stco, 8 + index * 4).map(u64::from))
                .collect::<Result<Vec<_>, _>>()?
        } else if let Some(co64) = child(stbl, b"co64") {
            let count = be_u32(co64, 4)? as usize;
            (0..count)
                .map(|index| be_u64(co64, 8 + index * 8))
                .collect::<Result<Vec<_>, _>>()?
        } else {
            return Err("video track has no chunk offsets".into());
        };
        return Ok(VideoTables {
            timescale,
            stts: child(stbl, b"stts").ok_or("video track has no stts")?,
            stss: child(stbl, b"stss"),
            stsz: child(stbl, b"stsz").ok_or("video track has no stsz")?,
            stsc: child(stbl, b"stsc").ok_or("video track has no stsc")?,
            chunk_offsets,
        });
    }
    Err("MP4 has no video track".into())
}

/// Parses a `moov` body into keyframe `(seconds, offset)` points.
pub fn byte_map_from_moov(moov: &[u8]) -> Result<ByteMap, String> {
    let tables = video_tables(moov)?;
    if tables.timescale == 0 {
        return Err("video track has no timescale".into());
    }

    // Sample sizes.
    let uniform = be_u32(tables.stsz, 4)?;
    let sample_count = be_u32(tables.stsz, 8)? as usize;
    let size_of = |index: usize| -> Result<u64, String> {
        if uniform != 0 {
            Ok(uniform as u64)
        } else {
            be_u32(tables.stsz, 12 + index * 4).map(u64::from)
        }
    };

    // Which samples become points.
    let mut wanted = vec![false; sample_count];
    match tables.stss {
        Some(stss) => {
            let count = be_u32(stss, 4)? as usize;
            for index in 0..count {
                let sample = be_u32(stss, 8 + index * 4)? as usize;
                if (1..=sample_count).contains(&sample) {
                    wanted[sample - 1] = true;
                }
            }
        }
        None => {
            for (index, slot) in wanted.iter_mut().enumerate() {
                *slot = index % SAMPLES_PER_POINT == 0;
            }
        }
    }

    // Decode times, in order.
    let mut times = Vec::with_capacity(sample_count);
    let mut clock = 0u64;
    let runs = be_u32(tables.stts, 4)? as usize;
    for run in 0..runs {
        let count = be_u32(tables.stts, 8 + run * 8)? as usize;
        let delta = be_u32(tables.stts, 12 + run * 8)? as u64;
        for _ in 0..count {
            if times.len() == sample_count {
                break;
            }
            times.push(clock);
            clock += delta;
        }
    }
    times.resize(sample_count, clock);

    // Walk chunks: stsc gives samples-per-chunk runs by first chunk number.
    let entries = be_u32(tables.stsc, 4)? as usize;
    let mut stsc = Vec::with_capacity(entries);
    for entry in 0..entries {
        let first_chunk = be_u32(tables.stsc, 8 + entry * 12)? as usize;
        let per_chunk = be_u32(tables.stsc, 12 + entry * 12)? as usize;
        stsc.push((first_chunk, per_chunk));
    }
    let mut points = Vec::new();
    let mut sample = 0usize;
    for (chunk_index, chunk_offset) in tables.chunk_offsets.iter().enumerate() {
        let chunk_number = chunk_index + 1;
        let per_chunk = stsc
            .iter()
            .rev()
            .find(|(first, _)| *first <= chunk_number)
            .map(|(_, per_chunk)| *per_chunk)
            .unwrap_or(0);
        let mut offset = *chunk_offset;
        for _ in 0..per_chunk {
            if sample >= sample_count {
                break;
            }
            if wanted[sample] {
                points.push((times[sample] as f64 / tables.timescale as f64, offset));
            }
            offset += size_of(sample)?;
            sample += 1;
        }
    }
    points.sort_by(|a, b| a.0.total_cmp(&b.0));
    Ok(points)
}

pub async fn read_byte_map<S: ByteSource>(source: &S) -> Result<ByteMap, String> {
    let moov = read_moov(source).await?;
    byte_map_from_moov(&moov)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mkv_index::SliceSource;
    use crate::test_support::fixture_mp4;

    /// ffmpeg's own packet positions are the ground truth.
    #[tokio::test]
    async fn keyframe_offsets_match_ffprobe() {
        let Some(path) = fixture_mp4(20) else {
            eprintln!("skipping: needs ffmpeg on PATH");
            return;
        };
        let bytes = std::fs::read(&path).unwrap();
        let map = read_byte_map(&SliceSource(&bytes)).await.unwrap();
        assert!(map.len() >= 4, "expected a keyframe every 4 s: {map:?}");
        let output = std::process::Command::new(crate::test_support::ffmpeg().unwrap().with_file_name("ffprobe"))
            .args(["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey"])
            .args(["-show_entries", "frame=pkt_pos,pts_time", "-of", "csv=p=0"])
            .arg(&path)
            .output();
        let Ok(output) = output else { return };
        let expected: Vec<(f64, u64)> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut parts = line.split(',');
                let time: f64 = parts.next()?.parse().ok()?;
                let pos: u64 = parts.next()?.parse().ok()?;
                Some((time, pos))
            })
            .collect();
        if expected.is_empty() {
            return;
        }
        let offsets: Vec<u64> = map.iter().map(|(_, offset)| *offset).collect();
        let wanted: Vec<u64> = expected.iter().map(|(_, offset)| *offset).collect();
        assert_eq!(offsets, wanted);
    }
}

