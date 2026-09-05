//! Cache budget helpers: the 10 GB disk floor and playback-window math.
//!
//! Cubo must never take the last of the volume (other processes die). The
//! window helpers describe an ideal sequential buffer; rqbit is not
//! sequential, so the engine only uses them as an emergency brake when the
//! disk is already at the floor.

/// Bytes Cubo always leaves free on the cache volume.
pub const DISK_RESERVE_BYTES: u64 = 10 * 1024 * 1024 * 1024;

/// Seconds of video to keep ahead of the playhead before pausing peers.
pub const PLAYBACK_LOOKAHEAD_SECS: f64 = 120.0;
/// Seconds of video to keep behind the playhead for small rewinds.
pub const PLAYBACK_REWIND_SECS: f64 = 60.0;

const WINDOW_MIN_BYTES: u64 = 512 * 1024 * 1024;
const WINDOW_MAX_BYTES: u64 = 3 * 1024 * 1024 * 1024;

/// True when the volume has no more than the reserved 10 GB left.
/// `None` means the volume could not be identified — that is not pressure.
pub fn disk_is_tight(free_bytes: Option<u64>) -> bool {
    match free_bytes {
        Some(free) => free <= DISK_RESERVE_BYTES,
        None => false,
    }
}

/// Enough downloaded data that pausing under disk pressure is unlikely to
/// starve a play that already started. rqbit is not sequential, so this is
/// only used as an emergency brake — not as a happy-path window.
pub fn has_emergency_buffer(progress_bytes: u64) -> bool {
    progress_bytes >= WINDOW_MIN_BYTES
}

/// How many downloaded bytes count as "enough for now" around the playhead.
/// Scales with the title's bitrate and stays inside 512 MB–3 GB.
pub fn playback_window_bytes(total_bytes: u64, duration_secs: f64) -> u64 {
    if total_bytes == 0 || duration_secs <= 0.0 {
        return WINDOW_MIN_BYTES;
    }
    let bytes_per_sec = total_bytes as f64 / duration_secs;
    let window = bytes_per_sec * (PLAYBACK_LOOKAHEAD_SECS + PLAYBACK_REWIND_SECS);
    (window as u64).clamp(WINDOW_MIN_BYTES, WINDOW_MAX_BYTES)
}

pub fn playhead_bytes(total_bytes: u64, position_secs: f64, duration_secs: f64) -> u64 {
    if total_bytes == 0 || duration_secs <= 0.0 {
        return 0;
    }
    let progress = (position_secs / duration_secs).clamp(0.0, 1.0);
    (total_bytes as f64 * progress) as u64
}

/// Pause peers once we already have a full window past the playhead.
pub fn should_pause_for_window(progress_bytes: u64, playhead: u64, window: u64) -> bool {
    progress_bytes >= playhead.saturating_add(window)
}

/// Resume peers when the playhead has eaten through half the window.
pub fn should_resume_for_window(progress_bytes: u64, playhead: u64, window: u64) -> bool {
    progress_bytes < playhead.saturating_add(window / 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_gigabytes_free_is_already_tight() {
        assert!(disk_is_tight(Some(DISK_RESERVE_BYTES)));
        assert!(disk_is_tight(Some(DISK_RESERVE_BYTES - 1)));
        assert!(disk_is_tight(Some(0)));
        assert!(!disk_is_tight(Some(DISK_RESERVE_BYTES + 1)));
        assert!(!disk_is_tight(None));
    }

    #[test]
    fn emergency_buffer_needs_the_window_floor() {
        assert!(!has_emergency_buffer(WINDOW_MIN_BYTES - 1));
        assert!(has_emergency_buffer(WINDOW_MIN_BYTES));
    }

    #[test]
    fn window_scales_with_bitrate_and_clamps() {
        // 2-hour 1080p-ish ~8 Mbps ≈ 1 MB/s → ~180 MB raw, so we hit the 512 MB floor.
        let hd = playback_window_bytes(2 * 3600 * 1_000_000, 2.0 * 3600.0);
        assert_eq!(hd, WINDOW_MIN_BYTES);

        // 2-hour 4K ~50 Mbps ≈ 6.25 MB/s → ~1.1 GB window.
        let uhd = playback_window_bytes(2 * 3600 * 6_250_000, 2.0 * 3600.0);
        assert!(uhd > WINDOW_MIN_BYTES);
        assert!(uhd < WINDOW_MAX_BYTES);

        // Absurd bitrate still caps at 3 GB so one title cannot fill the disk.
        let huge = playback_window_bytes(u64::MAX / 2, 60.0);
        assert_eq!(huge, WINDOW_MAX_BYTES);
    }

    #[test]
    fn playhead_maps_progress_onto_the_file() {
        assert_eq!(playhead_bytes(1_000, 30.0, 100.0), 300);
        assert_eq!(playhead_bytes(1_000, 0.0, 100.0), 0);
        assert_eq!(playhead_bytes(1_000, 200.0, 100.0), 1_000);
        assert_eq!(playhead_bytes(1_000, 10.0, 0.0), 0);
    }

    #[test]
    fn window_pause_and_resume_leave_a_gap() {
        let playhead = 1_000;
        let window = 400;
        assert!(!should_pause_for_window(1_399, playhead, window));
        assert!(should_pause_for_window(1_400, playhead, window));
        assert!(should_resume_for_window(1_199, playhead, window));
        assert!(!should_resume_for_window(1_200, playhead, window));
    }
}
