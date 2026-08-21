use tauri::{
    menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager,
};

/// Emitted to the webview whenever the user asks for an update check from
/// native chrome (macOS menu bar item, Windows titlebar button).
/// `UpdateBanner` listens for this and runs its normal check flow.
const CHECK_UPDATES_EVENT: &str = "cubo://check-updates";

pub fn run() {
    cubo_engine::raise_file_descriptor_limit();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                window.set_decorations(false)?;
            }

            #[cfg(target_os = "macos")]
            {
                let check_updates = MenuItemBuilder::with_id("check-updates", "Check for Updates…")
                    .accelerator("CmdOrCtrl+U")
                    .build(app)?;

                let about = PredefinedMenuItem::about(
                    app,
                    None,
                    Some(AboutMetadata {
                        name: Some("cubo".into()),
                        version: Some(app.package_info().version.to_string()),
                        ..Default::default()
                    }),
                )?;
                let services = PredefinedMenuItem::services(app, None)?;
                let hide = PredefinedMenuItem::hide(app, None)?;
                let hide_others = PredefinedMenuItem::hide_others(app, None)?;
                let show_all = PredefinedMenuItem::show_all(app, None)?;
                let quit = PredefinedMenuItem::quit(app, None)?;

                let undo = PredefinedMenuItem::undo(app, None)?;
                let redo = PredefinedMenuItem::redo(app, None)?;
                let cut = PredefinedMenuItem::cut(app, None)?;
                let copy = PredefinedMenuItem::copy(app, None)?;
                let paste = PredefinedMenuItem::paste(app, None)?;
                let select_all = PredefinedMenuItem::select_all(app, None)?;

                let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
                let minimize = PredefinedMenuItem::minimize(app, None)?;
                let close_window = PredefinedMenuItem::close_window(app, None)?;

                let app_submenu = SubmenuBuilder::new(app, "cubo")
                    .item(&about)
                    .separator()
                    .item(&check_updates)
                    .separator()
                    .item(&services)
                    .separator()
                    .item(&hide)
                    .item(&hide_others)
                    .item(&show_all)
                    .separator()
                    .item(&quit)
                    .build()?;

                let edit_submenu = SubmenuBuilder::new(app, "Edit")
                    .item(&undo)
                    .item(&redo)
                    .separator()
                    .item(&cut)
                    .item(&copy)
                    .item(&paste)
                    .separator()
                    .item(&select_all)
                    .build()?;

                let view_submenu = SubmenuBuilder::new(app, "View")
                    .item(&fullscreen)
                    .build()?;

                let window_submenu = SubmenuBuilder::new(app, "Window")
                    .item(&minimize)
                    .item(&close_window)
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .item(&app_submenu)
                    .item(&edit_submenu)
                    .item(&view_submenu)
                    .item(&window_submenu)
                    .build()?;
                app.set_menu(menu)?;
            }

            app.on_menu_event(|app, event| {
                if event.id() == "check-updates" {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.emit(CHECK_UPDATES_EVENT, ());
                    }
                }
            });

            let download_dir = app.path().app_data_dir()?.join("downloads");
            std::fs::create_dir_all(&download_dir)?;

            // File logging comes up before the engine so startup failures land
            // in cubo.log instead of vanishing with the webview's stderr.
            let _ = cubo_engine::logging::init(&cubo_engine::paths::data_dir());
            tracing::info!("Cubo desktop shell starting");

            let port = tauri::async_runtime::block_on(cubo_engine::engine::start(download_dir))
                .map_err(std::io::Error::other)?;
            tracing::info!("Cubo bridge listening on port {port}");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running cubo");
}
