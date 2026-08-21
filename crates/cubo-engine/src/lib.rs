//! Cubo Core: the torrent engine, HTTP bridge, and ffmpeg remux pipeline.
//! Shared by the Tauri desktop shell and the headless `cubo serve` CLI —
//! both expose the exact same /v1 API so the web app cannot tell them apart.

pub mod engine;
pub mod logging;
pub mod pairing;
pub mod paths;
pub mod store;
pub mod system;
pub mod transcode;

#[cfg(unix)]
/// macOS launches apps with a soft limit of ~256 open file descriptors.
/// A torrent engine plus HTTP bridge plus ffmpeg blows through that in
/// minutes, after which everything degrades semi-randomly: rqbit's internal
/// API refuses connections (playback 502s), streams stall, and even
/// directory scans fail with "too many open files". Raise the soft limit to
/// the allowed maximum before anything else starts.
pub fn raise_file_descriptor_limit() {
    unsafe {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 {
            // macOS caps per-process descriptors at OPEN_MAX (10240) even
            // when rlim_max reports infinity.
            let target = std::cmp::min(10_240, limit.rlim_max);
            if limit.rlim_cur < target {
                limit.rlim_cur = target;
                if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) != 0 {
                    eprintln!("Cubo could not raise the open-file limit");
                }
            }
        }
    }
}

#[cfg(not(unix))]
pub fn raise_file_descriptor_limit() {}
