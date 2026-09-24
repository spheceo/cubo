//! Disk pressure thresholds for cache eviction and emergency pausing.
//!
//! Cubo must never take the last of the volume (other processes die). The
//! torrent engine is not sequential, so pausing is reserved for a nearly
//! full disk.

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

#[cfg(test)]
mod tests {
    use super::*;

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
