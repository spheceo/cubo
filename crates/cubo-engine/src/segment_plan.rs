//! The fixed segment layout of a session's VOD playlist.
//!
//! Boundaries are decided once, before conversion starts, from the source's
//! keyframe index. Every remux job — whichever segment it starts at — files
//! its output under the same boundaries, so a segment's URL always names the
//! same stretch of the movie and the player sees one ordinary, full-length
//! video.

/// Preferred segment length. Copy-mode segments can only start on keyframes,
/// so real lengths are "the first keyframe at least this far on".
pub const TARGET_SECONDS: f64 = 6.0;
/// Without a keyframe index the grid must be coarse enough that almost every
/// cell contains a keyframe.
const GRID_SECONDS: f64 = 10.0;
/// A final sliver shorter than this merges into the previous segment.
const MIN_TAIL_SECONDS: f64 = 1.0;
/// ffmpeg may report a fragment's decode time slightly before the keyframe's
/// index time (B-frame reordering); it still belongs to that boundary.
pub const BOUNDARY_TOLERANCE: f64 = 0.15;

#[derive(Debug, Clone, PartialEq)]
pub struct SegmentPlan {
    /// Start time of every segment, ascending, `starts[0] == 0`.
    starts: Vec<f64>,
    duration: f64,
    /// True when boundaries come from a real keyframe index.
    exact: bool,
}

impl SegmentPlan {
    /// `keyframes` are presentation times from the container index.
    pub fn from_keyframes(keyframes: &[f64], duration: f64) -> Self {
        let mut starts = vec![0.0];
        for &keyframe in keyframes {
            if keyframe <= 0.0 || keyframe >= duration {
                continue;
            }
            if keyframe - starts.last().copied().unwrap_or(0.0) >= TARGET_SECONDS {
                starts.push(keyframe);
            }
        }
        Self::finish(starts, duration, true)
    }

    /// Fallback for files without an index: fixed cells. A job that starts
    /// at cell `k` seeks to the keyframe before `k * GRID` and drops what
    /// precedes the cell, so every cell's content starts at its first
    /// keyframe.
    pub fn grid(duration: f64) -> Self {
        let count = (duration / GRID_SECONDS).ceil().max(1.0) as usize;
        let starts = (0..count).map(|index| index as f64 * GRID_SECONDS).collect();
        Self::finish(starts, duration, false)
    }

    fn finish(mut starts: Vec<f64>, duration: f64, exact: bool) -> Self {
        while starts.len() > 1 && duration - starts[starts.len() - 1] < MIN_TAIL_SECONDS {
            starts.pop();
        }
        Self {
            starts,
            duration,
            exact,
        }
    }

    pub fn len(&self) -> usize {
        self.starts.len()
    }

    pub fn duration(&self) -> f64 {
        self.duration
    }

    pub fn is_exact(&self) -> bool {
        self.exact
    }

    pub fn start(&self, index: usize) -> f64 {
        self.starts[index]
    }

    pub fn end(&self, index: usize) -> f64 {
        self.starts.get(index + 1).copied().unwrap_or(self.duration)
    }

    /// Segment containing presentation time `seconds`.
    pub fn index_at(&self, seconds: f64) -> usize {
        match self.starts.partition_point(|start| *start <= seconds) {
            0 => 0,
            after => after - 1,
        }
    }

    /// Segment a remuxed fragment belongs to, from its first decode time.
    pub fn index_for_fragment(&self, decode_seconds: f64) -> usize {
        self.index_at(decode_seconds + BOUNDARY_TOLERANCE)
    }

    /// Where ffmpeg's input seek should aim to begin producing `index`.
    /// Slightly past the boundary so an exact keyframe is not rounded to the
    /// previous one; `-noaccurate_seek` then lands on that keyframe.
    pub fn seek_target(&self, index: usize) -> Option<f64> {
        if index == 0 {
            return None;
        }
        let start = self.starts[index];
        Some(if self.exact { start + 0.005 } else { start })
    }

    /// Renders the complete VOD playlist. `query` is appended to every URI
    /// (tokens ride in the query string because players fetch URIs verbatim).
    pub fn playlist(&self, query: &str) -> String {
        let longest = (0..self.len())
            .map(|index| self.end(index) - self.start(index))
            .fold(0.0f64, f64::max);
        let mut out = String::with_capacity(64 + self.len() * 48);
        out.push_str("#EXTM3U\n#EXT-X-VERSION:7\n");
        out.push_str(&format!("#EXT-X-TARGETDURATION:{}\n", longest.ceil().max(1.0) as u64));
        out.push_str("#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n");
        out.push_str(&format!("#EXT-X-MAP:URI=\"init.mp4?{query}\"\n"));
        for index in 0..self.len() {
            let length = self.end(index) - self.start(index);
            out.push_str(&format!("#EXTINF:{length:.6},\n{index}.m4s?{query}\n"));
        }
        out.push_str("#EXT-X-ENDLIST\n");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundaries_follow_keyframes() {
        let keyframes = [0.0, 3.7, 7.4, 11.1, 14.8, 18.5, 22.2];
        let plan = SegmentPlan::from_keyframes(&keyframes, 24.0);
        assert_eq!(plan.starts, vec![0.0, 7.4, 14.8, 22.2]);
        assert_eq!(plan.end(3), 24.0);
        assert_eq!(plan.index_at(7.39), 0);
        assert_eq!(plan.index_at(7.4), 1);
        assert_eq!(plan.index_at(1000.0), 3);
    }

    #[test]
    fn fragments_just_before_a_boundary_file_under_it() {
        let plan = SegmentPlan::from_keyframes(&[0.0, 6.2, 12.4], 20.0);
        assert_eq!(plan.index_for_fragment(6.117), 1);
        assert_eq!(plan.index_for_fragment(5.0), 0);
    }

    #[test]
    fn tiny_tail_merges() {
        let plan = SegmentPlan::from_keyframes(&[0.0, 6.0, 12.0], 12.5);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan.end(1), 12.5);
    }

    #[test]
    fn grid_covers_duration() {
        let plan = SegmentPlan::grid(95.0);
        assert_eq!(plan.len(), 10);
        assert_eq!(plan.end(9), 95.0);
        assert_eq!(plan.seek_target(3), Some(30.0));
    }

    #[test]
    fn playlist_is_complete_vod() {
        let plan = SegmentPlan::from_keyframes(&[0.0, 6.5], 13.0);
        let text = plan.playlist("token=t");
        assert!(text.contains("#EXT-X-PLAYLIST-TYPE:VOD"));
        assert!(text.contains("#EXT-X-MAP:URI=\"init.mp4?token=t\""));
        assert!(text.contains("#EXTINF:6.500000,\n0.m4s?token=t"));
        assert!(text.contains("#EXTINF:6.500000,\n1.m4s?token=t"));
        assert!(text.trim_end().ends_with("#EXT-X-ENDLIST"));
        assert!(text.contains("#EXT-X-TARGETDURATION:7"));
    }
}
