mod engine;

#[tauri::command]
async fn engine_status() -> serde_json::Value {
    engine::status()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![engine_status])
        .run(tauri::generate_context!())
        .expect("error while running cubo");
}
