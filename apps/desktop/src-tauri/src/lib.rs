mod engine;
mod store;
mod transcode;

use tauri::Manager;

/// macOS launches GUI apps with a soft limit of ~256 open file descriptors.
/// A torrent engine plus HTTP bridge plus ffmpeg blows through that in
/// minutes, after which everything degrades semi-randomly: rqbit's internal
/// API refuses connections (playback 502s), streams stall, and even
/// directory scans fail with "too many open files". Raise the soft limit to
/// the allowed maximum before anything else starts.
#[cfg(unix)]
fn raise_file_descriptor_limit() {
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
fn raise_file_descriptor_limit() {}

pub fn run() {
    raise_file_descriptor_limit();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                window.set_decorations(false)?;
            }

            let download_dir = app.path().app_data_dir()?.join("downloads");
            std::fs::create_dir_all(&download_dir)?;

            let port = tauri::async_runtime::block_on(engine::start(download_dir))
                .map_err(std::io::Error::other)?;
            eprintln!("Cubo bridge listening on port {port}");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running cubo");
}
