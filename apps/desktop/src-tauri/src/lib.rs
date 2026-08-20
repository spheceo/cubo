mod engine;
mod store;
mod transcode;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
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
