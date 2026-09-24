//! Reads an MKV's keyframe index (the Cues element) with a handful of ranged
//! reads, so a playback session can publish a complete, correctly cut HLS
//! playlist before any video has been converted.
//!
//! Only the elements needed for that are parsed: Info (timestamp scale and
//! duration), Tracks (which track is video), SeekHead (where Cues live) and
//! Cues. Clusters are never walked — Cues usually sit at the end of the file,
//! reachable through the SeekHead, so a cold torrent pays for the header piece
//! and one tail piece instead of the whole file.

use std::future::Future;

const EBML_HEADER: u32 = 0x1A45_DFA3;
const SEGMENT: u32 = 0x1853_8067;
const SEEK_HEAD: u32 = 0x114D_9B74;
const SEEK: u32 = 0x4DBB;
const SEEK_ID: u32 = 0x53AB;
const SEEK_POSITION: u32 = 0x53AC;
const INFO: u32 = 0x1549_A966;
const TIMESTAMP_SCALE: u32 = 0x2A_D7B1;
const DURATION: u32 = 0x4489;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const TRACK_NUMBER: u32 = 0xD7;
const TRACK_TYPE: u32 = 0x83;
const CODEC_ID: u32 = 0x86;
const CUES: u32 = 0x1C53_BB6B;
const CUE_POINT: u32 = 0xBB;
const CUE_TIME: u32 = 0xB3;
const CUE_TRACK_POSITIONS: u32 = 0xB7;
const CUE_TRACK: u32 = 0xF7;
const CUE_CLUSTER_POSITION: u32 = 0xF1;
const CLUSTER: u32 = 0x1F43_B675;

/// First read: the EBML header, SeekHead, Info and Tracks almost always fit.
const HEAD_READ: u64 = 256 * 1024;
/// Metadata elements larger than this are not metadata we can trust.
const MAX_METADATA_ELEMENT: u64 = 16 * 1024 * 1024;
/// A three-hour film with a keyframe per second indexes in well under 1 MB.
const MAX_CUES_ELEMENT: u64 = 32 * 1024 * 1024;

/// Random access into the source file. Sessions implement this over the
/// torrent stream, tests over a byte slice.
pub trait ByteSource {
    fn len(&self) -> u64;
    fn read_at(&self, offset: u64, length: u64) -> impl Future<Output = Result<Vec<u8>, String>> + Send;
}

#[derive(Debug, Clone, PartialEq)]
pub struct MkvIndex {
    pub duration_seconds: Option<f64>,
    pub video_codec_id: Option<String>,
    /// Presentation times of the video keyframes listed in Cues, ascending.
    /// Empty when the file carries no usable index.
    pub keyframes: Vec<f64>,
    /// `(seconds, absolute byte offset of the cluster)` per video cue,
    /// ascending: maps downloaded bytes to movie time.
    pub byte_map: Vec<(f64, u64)>,
}

#[derive(Debug, Clone, Copy)]
struct Header {
    id: u32,
    /// Offset of the element's data (just past id and size).
    data_start: u64,
    /// `None` for EBML "unknown size" (live-written elements).
    size: Option<u64>,
}

/// Parses one element header at the start of `bytes`. Returns the header and
/// how many bytes it occupied, or `None` if `bytes` is too short.
fn parse_header(bytes: &[u8], base: u64) -> Result<Option<(Header, usize)>, String> {
    let Some((id, id_len)) = read_id(bytes)? else {
        return Ok(None);
    };
    let Some((size, size_len)) = read_size(&bytes[id_len..])? else {
        return Ok(None);
    };
    let used = id_len + size_len;
    Ok(Some((
        Header {
            id,
            data_start: base + used as u64,
            size,
        },
        used,
    )))
}

fn vint_length(first: u8) -> Result<usize, String> {
    if first == 0 {
        return Err("invalid EBML variable-length integer".into());
    }
    Ok(first.leading_zeros() as usize + 1)
}

/// Element IDs keep their length marker bits.
fn read_id(bytes: &[u8]) -> Result<Option<(u32, usize)>, String> {
    let Some(&first) = bytes.first() else {
        return Ok(None);
    };
    let length = vint_length(first)?;
    if length > 4 {
        return Err("EBML element ID longer than 4 bytes".into());
    }
    if bytes.len() < length {
        return Ok(None);
    }
    let id = bytes[..length]
        .iter()
        .fold(0u32, |value, byte| (value << 8) | u32::from(*byte));
    Ok(Some((id, length)))
}

/// Sizes drop their marker bit; all value bits set means "unknown".
fn read_size(bytes: &[u8]) -> Result<Option<(Option<u64>, usize)>, String> {
    let Some(&first) = bytes.first() else {
        return Ok(None);
    };
    let length = vint_length(first)?;
    if length > 8 {
        return Err("EBML size longer than 8 bytes".into());
    }
    if bytes.len() < length {
        return Ok(None);
    }
    let mask = if length == 8 { 0 } else { 0xFFu8 >> length };
    let mut value = u64::from(first & mask);
    for byte in &bytes[1..length] {
        value = (value << 8) | u64::from(*byte);
    }
    let unknown = value == (1u64 << (7 * length)) - 1;
    Ok(Some((if unknown { None } else { Some(value) }, length)))
}

fn read_uint(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .take(8)
        .fold(0u64, |value, byte| (value << 8) | u64::from(*byte))
}

fn read_float(bytes: &[u8]) -> Option<f64> {
    match bytes.len() {
        4 => Some(f64::from(f32::from_be_bytes(bytes.try_into().ok()?))),
        8 => Some(f64::from_be_bytes(bytes.try_into().ok()?)),
        _ => None,
    }
}

/// Iterates the direct children of a fully buffered element body.
fn children(body: &[u8]) -> impl Iterator<Item = Result<(u32, &[u8]), String>> {
    let mut offset = 0usize;
    std::iter::from_fn(move || {
        if offset >= body.len() {
            return None;
        }
        let parsed = match parse_header(&body[offset..], 0) {
            Ok(Some(parsed)) => parsed,
            Ok(None) => return Some(Err("truncated EBML element".into())),
            Err(error) => return Some(Err(error)),
        };
        let (header, used) = parsed;
        let start = offset + used;
        let Some(size) = header.size else {
            // Unknown-size children only appear for Segment/Cluster.
            offset = body.len();
            return Some(Ok((header.id, &body[start..])));
        };
        let end = start.saturating_add(size as usize).min(body.len());
        offset = end;
        Some(Ok((header.id, &body[start..end])))
    })
}

#[derive(Default)]
struct Metadata {
    timestamp_scale: Option<u64>,
    duration_ticks: Option<f64>,
    video_track: Option<u64>,
    video_codec_id: Option<String>,
    cues_position: Option<u64>,
    extra_seek_heads: Vec<u64>,
}

impl Metadata {
    fn apply_seek_head(&mut self, body: &[u8]) -> Result<(), String> {
        for child in children(body) {
            let (id, seek) = child?;
            if id != SEEK {
                continue;
            }
            let mut target = None;
            let mut position = None;
            for field in children(seek) {
                let (field_id, value) = field?;
                match field_id {
                    SEEK_ID => target = Some(read_uint(value) as u32),
                    SEEK_POSITION => position = Some(read_uint(value)),
                    _ => {}
                }
            }
            match (target, position) {
                (Some(CUES), Some(position)) => self.cues_position = Some(position),
                (Some(SEEK_HEAD), Some(position)) => self.extra_seek_heads.push(position),
                _ => {}
            }
        }
        Ok(())
    }

    fn apply_info(&mut self, body: &[u8]) -> Result<(), String> {
        for child in children(body) {
            let (id, value) = child?;
            match id {
                TIMESTAMP_SCALE => self.timestamp_scale = Some(read_uint(value)),
                DURATION => self.duration_ticks = read_float(value),
                _ => {}
            }
        }
        Ok(())
    }

    fn apply_tracks(&mut self, body: &[u8]) -> Result<(), String> {
        for child in children(body) {
            let (id, entry) = child?;
            if id != TRACK_ENTRY {
                continue;
            }
            let mut number = None;
            let mut kind = None;
            let mut codec = None;
            for field in children(entry) {
                let (field_id, value) = field?;
                match field_id {
                    TRACK_NUMBER => number = Some(read_uint(value)),
                    TRACK_TYPE => kind = Some(read_uint(value)),
                    CODEC_ID => codec = Some(String::from_utf8_lossy(value).trim_end_matches('\0').to_owned()),
                    _ => {}
                }
            }
            // First video track wins, matching the remux's `-map 0:v:0`.
            if kind == Some(1) && self.video_track.is_none() {
                self.video_track = number;
                self.video_codec_id = codec;
            }
        }
        Ok(())
    }

    fn scale_seconds(&self) -> f64 {
        self.timestamp_scale.unwrap_or(1_000_000) as f64 / 1e9
    }
}

async fn read_element<S: ByteSource>(
    source: &S,
    position: u64,
    expected: u32,
    limit: u64,
) -> Result<Option<Vec<u8>>, String> {
    if position >= source.len() {
        return Ok(None);
    }
    let head = source.read_at(position, 16.min(source.len() - position)).await?;
    let Some((header, _)) = parse_header(&head, position)? else {
        return Ok(None);
    };
    if header.id != expected {
        return Ok(None);
    }
    let Some(size) = header.size else {
        return Ok(None);
    };
    if size > limit || header.data_start + size > source.len() {
        return Ok(None);
    }
    source.read_at(header.data_start, size).await.map(Some)
}

/// Keyframe times, plus `(time, segment-relative cluster position)` pairs.
type Cues = (Vec<f64>, Vec<(f64, u64)>);

fn parse_cues(body: &[u8], video_track: Option<u64>, scale: f64) -> Result<Cues, String> {
    let mut keyframes = Vec::new();
    let mut positions = Vec::new();
    for child in children(body) {
        let (id, point) = child?;
        if id != CUE_POINT {
            continue;
        }
        let mut time = None;
        let mut matches_track = false;
        let mut cluster = None;
        for field in children(point) {
            let (field_id, value) = field?;
            match field_id {
                CUE_TIME => time = Some(read_uint(value)),
                CUE_TRACK_POSITIONS => {
                    let mut this_track = false;
                    let mut this_cluster = None;
                    for position in children(value) {
                        let (position_id, position_value) = position?;
                        match position_id {
                            CUE_TRACK => {
                                this_track = video_track
                                    .is_none_or(|track| read_uint(position_value) == track);
                            }
                            CUE_CLUSTER_POSITION => this_cluster = Some(read_uint(position_value)),
                            _ => {}
                        }
                    }
                    if this_track {
                        matches_track = true;
                        cluster = cluster.or(this_cluster);
                    }
                }
                _ => {}
            }
        }
        if let (Some(time), true) = (time, matches_track) {
            let seconds = time as f64 * scale;
            keyframes.push(seconds);
            if let Some(cluster) = cluster {
                positions.push((seconds, cluster));
            }
        }
    }
    keyframes.sort_by(|a, b| a.total_cmp(b));
    keyframes.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    positions.sort_by(|a, b| a.0.total_cmp(&b.0));
    Ok((keyframes, positions))
}

/// Reads the keyframe index. A file without Cues still returns duration and
/// codec with an empty keyframe list; callers fall back to a time grid.
pub async fn read_index<S: ByteSource>(source: &S) -> Result<MkvIndex, String> {
    let file_len = source.len();
    let head = source.read_at(0, HEAD_READ.min(file_len)).await?;
    let Some((ebml, used)) = parse_header(&head, 0)? else {
        return Err("file is too short to be Matroska".into());
    };
    if ebml.id != EBML_HEADER {
        return Err("not a Matroska file".into());
    }
    let ebml_end = used as u64 + ebml.size.ok_or("EBML header has unknown size")?;
    let segment_bytes = head
        .get(ebml_end as usize..)
        .ok_or("Matroska header does not fit the first read")?;
    let Some((segment, segment_used)) = parse_header(segment_bytes, ebml_end)? else {
        return Err("Matroska segment header is truncated".into());
    };
    if segment.id != SEGMENT {
        return Err("Matroska segment not found".into());
    }
    let segment_start = segment.data_start;
    let segment_end = segment
        .size
        .map(|size| segment_start + size)
        .unwrap_or(file_len)
        .min(file_len);

    // Walk top-level elements up to the first Cluster. Everything we need is
    // normally inside the first read; bigger elements are fetched on demand.
    let mut metadata = Metadata::default();
    let mut cues_body: Option<Vec<u8>> = None;
    let mut position = ebml_end + segment_used as u64;
    while position < segment_end {
        let local = (position as usize) < head.len();
        let header_bytes = if local && head.len() - position as usize >= 16 {
            head[position as usize..position as usize + 16].to_vec()
        } else {
            source.read_at(position, 16.min(file_len - position)).await?
        };
        let Some((header, _)) = parse_header(&header_bytes, position)? else {
            break;
        };
        if header.id == CLUSTER {
            break;
        }
        let Some(size) = header.size else {
            break;
        };
        let wanted = matches!(header.id, SEEK_HEAD | INFO | TRACKS | CUES);
        if wanted {
            let limit = if header.id == CUES { MAX_CUES_ELEMENT } else { MAX_METADATA_ELEMENT };
            if size > limit {
                return Err("Matroska metadata element is implausibly large".into());
            }
            let end = header.data_start + size;
            let body = if end as usize <= head.len() {
                head[header.data_start as usize..end as usize].to_vec()
            } else {
                source.read_at(header.data_start, size).await?
            };
            match header.id {
                SEEK_HEAD => metadata.apply_seek_head(&body)?,
                INFO => metadata.apply_info(&body)?,
                TRACKS => metadata.apply_tracks(&body)?,
                CUES => cues_body = Some(body),
                _ => {}
            }
        }
        position = header.data_start + size;
    }

    // A SeekHead may defer part of the index to a second SeekHead.
    for extra in std::mem::take(&mut metadata.extra_seek_heads) {
        if let Some(body) =
            read_element(source, segment_start + extra, SEEK_HEAD, MAX_METADATA_ELEMENT).await?
        {
            metadata.apply_seek_head(&body)?;
        }
    }

    if cues_body.is_none() {
        if let Some(relative) = metadata.cues_position {
            cues_body = read_element(source, segment_start + relative, CUES, MAX_CUES_ELEMENT).await?;
        }
    }

    let scale = metadata.scale_seconds();
    let (keyframes, positions) = match cues_body {
        Some(body) => parse_cues(&body, metadata.video_track, scale)?,
        None => (Vec::new(), Vec::new()),
    };
    let byte_map = positions
        .into_iter()
        .map(|(seconds, relative)| (seconds, segment_start + relative))
        .collect();
    Ok(MkvIndex {
        duration_seconds: metadata
            .duration_ticks
            .map(|ticks| ticks * scale)
            .filter(|seconds| seconds.is_finite() && *seconds > 0.0),
        video_codec_id: metadata.video_codec_id,
        keyframes,
        byte_map,
    })
}

#[cfg(test)]
pub(crate) struct SliceSource<'a>(pub &'a [u8]);

#[cfg(test)]
impl ByteSource for SliceSource<'_> {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }

    async fn read_at(&self, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        let start = offset as usize;
        let end = (offset + length) as usize;
        self.0
            .get(start..end)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "read past end".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn element(id: u32, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let id_bytes = id.to_be_bytes();
        let skip = id_bytes.iter().position(|byte| *byte != 0).unwrap_or(3);
        out.extend_from_slice(&id_bytes[skip..]);
        // 8-byte size keeps the builder simple.
        out.push(0x01);
        out.extend_from_slice(&(body.len() as u64).to_be_bytes()[1..]);
        out.extend_from_slice(body);
        out
    }

    fn uint(id: u32, value: u64) -> Vec<u8> {
        element(id, &value.to_be_bytes())
    }

    fn cue(time: u64, track: u64) -> Vec<u8> {
        let positions = [uint(CUE_TRACK, track), uint(0xF1, 0)].concat();
        element(CUE_POINT, &[uint(CUE_TIME, time), element(CUE_TRACK_POSITIONS, &positions)].concat())
    }

    fn build(cues_at_end: bool) -> Vec<u8> {
        let info = element(
            INFO,
            &[uint(TIMESTAMP_SCALE, 1_000_000), element(DURATION, &120_500.0f64.to_be_bytes())].concat(),
        );
        let tracks = element(
            TRACKS,
            &[
                element(TRACK_ENTRY, &[uint(TRACK_NUMBER, 1), uint(TRACK_TYPE, 2), element(CODEC_ID, b"A_AC3")].concat()),
                element(TRACK_ENTRY, &[uint(TRACK_NUMBER, 2), uint(TRACK_TYPE, 1), element(CODEC_ID, b"V_MPEG4/ISO/AVC")].concat()),
            ]
            .concat(),
        );
        let cues = element(CUES, &[cue(0, 2), cue(4_000, 1), cue(4_170, 2), cue(8_342, 2)].concat());
        let cluster = element(CLUSTER, &vec![0u8; 4096]);
        let seek_head_len = 64;
        // Segment-relative position of Cues when it follows the cluster.
        let cues_relative = (seek_head_len + info.len() + tracks.len() + cluster.len()) as u64;
        let mut seek_head = element(
            SEEK_HEAD,
            &element(SEEK, &[element(SEEK_ID, &CUES.to_be_bytes()), uint(SEEK_POSITION, cues_relative)].concat()),
        );
        // Pad the SeekHead with a Void element so its length is fixed.
        let void_len = seek_head_len - seek_head.len();
        seek_head.extend(element(0xEC, &vec![0; void_len - 9]));
        assert_eq!(seek_head.len(), seek_head_len);
        let body = if cues_at_end {
            [seek_head, info, tracks, cluster, cues].concat()
        } else {
            [info, tracks, cues, cluster].concat()
        };
        [element(EBML_HEADER, &uint(0x4282, 0)), element(SEGMENT, &body)].concat()
    }

    #[tokio::test]
    async fn reads_cues_through_the_seek_head() {
        let bytes = build(true);
        let index = read_index(&SliceSource(&bytes)).await.unwrap();
        assert_eq!(index.keyframes, vec![0.0, 4.17, 8.342]);
        assert_eq!(index.duration_seconds, Some(120.5));
        assert_eq!(index.video_codec_id.as_deref(), Some("V_MPEG4/ISO/AVC"));
    }

    #[tokio::test]
    async fn reads_cues_placed_before_clusters() {
        let bytes = build(false);
        let index = read_index(&SliceSource(&bytes)).await.unwrap();
        assert_eq!(index.keyframes, vec![0.0, 4.17, 8.342]);
    }

    #[tokio::test]
    async fn rejects_non_matroska() {
        let bytes = vec![0u8; 64];
        assert!(read_index(&SliceSource(&bytes)).await.is_err());
    }

    /// Checks the parser against an ffmpeg-written file when one is supplied:
    /// `CUBO_MKV_FIXTURE=/path/file.mkv cargo test -p cubo-engine mkv_fixture -- --ignored`
    #[tokio::test]
    #[ignore = "needs CUBO_MKV_FIXTURE"]
    async fn mkv_fixture_index() {
        let path = std::env::var("CUBO_MKV_FIXTURE").expect("CUBO_MKV_FIXTURE");
        let bytes = std::fs::read(path).unwrap();
        let index = read_index(&SliceSource(&bytes)).await.unwrap();
        eprintln!("{index:?}");
        assert!(!index.keyframes.is_empty());
    }
}
