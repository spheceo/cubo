//! Disk pressure thresholds for cache eviction and emergency pausing.
//!
//! Cubo must never take the last of the volume (other processes die). The
//! torrent engine is not sequential, so pausing is reserved for a nearly
//! full disk.

use std::collections::HashSet;

use crate::store::LibraryItem;

/// Bytes Cubo always leaves free on the cache volume.
pub const DISK_RESERVE_BYTES: u64 = 1024 * 1024 * 1024;
/// Pause even the title being watched only when the volume is about to
/// hit ENOSPC. The 1 GiB reserve drives eviction of *other* titles — it
/// must not starve remux of peers.
pub const DISK_CRITICAL_BYTES: u64 = 512 * 1024 * 1024;

/// True when the volume has no more than the reserved 1 GiB left.
/// `None` means the volume could not be identified — that is not pressure.
pub fn disk_is_tight(free_bytes: Option<u64>) -> bool {
    match free_bytes {
        Some(free) => free <= DISK_RESERVE_BYTES,
        None => false,
    }
}

/// True when the next write is likely to fail. Unknown volume is not this.
pub fn disk_is_critical(free_bytes: Option<u64>) -> bool {
    match free_bytes {
        Some(free) => free <= DISK_CRITICAL_BYTES,
        None => false,
    }
}

/// A title watched within this long and left part-way through is one the
/// viewer is coming back to.
pub const IN_PROGRESS_RECENT_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// Past this share the title is as good as finished.
const IN_PROGRESS_DONE: f64 = 0.95;

/// Media keys the viewer is part-way through (started, not finished, not
/// abandoned). Eviction spares their files until last: on 2026-10-21 a
/// tight disk took the season pack a viewer was 72% into, and resuming
/// went from a second to two minutes on a worse source.
pub fn unfinished_keys(history: &[LibraryItem], now: u64) -> HashSet<String> {
    history
        .iter()
        .filter(|item| {
            !item.completed
                && item.position_seconds > 0.0
                && item.progress < IN_PROGRESS_DONE
                && now.saturating_sub(item.last_watched_at) <= IN_PROGRESS_RECENT_MS
        })
        .map(|item| item.key.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(key: &str, progress: f64, completed: bool, last_watched_at: u64) -> LibraryItem {
        serde_json::from_value(serde_json::json!({
            "key": key, "mediaId": 1, "mediaType": "tv", "imdbId": null, "title": "T",
            "subtitle": null, "posterPath": null, "backdropPath": null, "season": 1,
            "episode": 1, "positionSeconds": progress * 3000.0, "durationSeconds": 3000.0,
            "progress": progress, "completed": completed, "lastWatchedAt": last_watched_at,
            "watchHref": "/", "detailHref": "/",
        }))
        .unwrap()
    }

    #[test]
    fn only_titles_left_part_way_and_recently_are_unfinished() {
        let now = IN_PROGRESS_RECENT_MS * 2;
        let history = vec![
            item("tv:1:1:2", 0.72, false, now - 1000),
            item("tv:1:1:1", 0.99, true, now - 2000),
            item("tv:2:1:1", 0.97, false, now - 1000),
            item("tv:3:1:1", 0.0, false, now - 1000),
            item("movie:4:-:-", 0.4, false, now - IN_PROGRESS_RECENT_MS - 1),
        ];
        let keys = unfinished_keys(&history, now);
        assert_eq!(keys, HashSet::from(["tv:1:1:2".to_string()]));
    }

    #[test]
    fn one_gibibyte_free_is_already_tight() {
        assert!(disk_is_tight(Some(DISK_RESERVE_BYTES)));
        assert!(disk_is_tight(Some(DISK_RESERVE_BYTES - 1)));
        assert!(disk_is_tight(Some(0)));
        assert!(!disk_is_tight(Some(DISK_RESERVE_BYTES + 1)));
        assert!(!disk_is_tight(None));
    }

    #[test]
    fn critical_is_much_tighter_than_the_reserve() {
        assert!(!disk_is_critical(Some(DISK_RESERVE_BYTES)));
        assert!(!disk_is_critical(Some(DISK_CRITICAL_BYTES + 1)));
        assert!(disk_is_critical(Some(DISK_CRITICAL_BYTES)));
        assert!(disk_is_critical(Some(0)));
        assert!(!disk_is_critical(None));
    }

}
