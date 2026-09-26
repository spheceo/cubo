//! Filesystem-level cache regression tests.
//!
//! These deliberately use private helpers through the parent test module and
//! temporary directories only. HTTP/Core lifecycle tests belong in engine.rs,
//! where BridgeState construction is already available.

use std::fs::{self, OpenOptions};

use uuid::Uuid;

use super::*;

fn temp_dir(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("cubo-{label}-{}", Uuid::new_v4()));
    fs::create_dir_all(&path).expect("create temporary cache directory");
    path
}

#[tokio::test]
async fn reset_cache_directory_returns_to_default_and_clears_override() {
    let root = temp_dir("reset-directory");
    let custom = root.join("custom");
    fs::create_dir_all(&custom).unwrap();
    let core = spawn_test_core(&root, 10 * 1024 * 1024 * 1024).await;
    let client = reqwest::Client::new();
    let directory_url = format!("{}/v1/cache/directory", core.base_url);

    let changed = client
        .put(&directory_url)
        .bearer_auth(&core.token)
        .json(&json!({ "directory": custom }))
        .send()
        .await
        .unwrap();
    assert_eq!(changed.status(), StatusCode::OK);
    fs::write(custom.join("cached.mp4"), b"cached").unwrap();

    let reset = client
        .delete(&directory_url)
        .bearer_auth(&core.token)
        .send()
        .await
        .unwrap();
    assert_eq!(reset.status(), StatusCode::OK);
    let status: serde_json::Value = client
        .get(format!("{}/v1/cache", core.base_url))
        .bearer_auth(&core.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let expected = root.join("downloads").to_string_lossy().into_owned();
    assert_eq!(status["directory"], expected);
    assert_eq!(status["defaultDirectory"], expected);
    assert!(!custom.join("cached.mp4").exists());
    let store = CoreStore::load(root.join("cubo-state.json")).await.unwrap();
    assert!(store.cache_snapshot().await.cache.directory.is_none());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn wipe_dir_contents_removes_nested_cache_files() {
    let root = temp_dir("wipe");
    let nested = root.join("title");
    fs::create_dir_all(&nested).expect("create nested directory");
    fs::write(nested.join("episode.mkv"), b"cached").expect("write cache file");

    wipe_dir_contents(&root).expect("wipe cache");

    assert!(root.exists());
    assert_eq!(fs::read_dir(&root).expect("read cache").count(), 0);
    fs::remove_dir_all(root).expect("remove temporary directory");
}

#[cfg(unix)]
#[test]
fn sparse_files_are_counted_by_allocated_space() {
    let root = temp_dir("sparse");
    let path = root.join("large-sparse-file");
    let logical_size = 64 * 1024 * 1024;
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .open(&path)
        .expect("create sparse file");
    file.set_len(logical_size).expect("set sparse length");

    let measured = directory_size(&root).expect("measure cache");
    assert!(
        measured < logical_size,
        "sparse file was counted logically: {measured}"
    );

    fs::remove_dir_all(root).expect("remove temporary directory");
}

#[test]
fn reclaim_untracked_keeps_roots_still_in_the_cache_index() {
    let root = temp_dir("tracked-reclaim");
    let kept = root.join("kept.mp4");
    let orphan = root.join("orphan.mp4");
    for path in [&kept, &orphan] {
        fs::write(path, vec![1u8; 4096]).unwrap();
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH))
            .unwrap();
    }

    reclaim_untracked(&root, 0, &HashSet::from([kept.clone()])).unwrap();

    assert!(kept.exists());
    assert!(!orphan.exists());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn unsafe_recorded_path_is_refused_and_outside_file_survives() {
    let root = temp_dir("safe-delete");
    let outside = root
        .parent()
        .expect("temporary parent")
        .join(format!("cubo-outside-{}", Uuid::new_v4()));
    fs::write(&outside, b"must survive").expect("write outside file");

    let recorded = root.join("..").join(
        outside
            .file_name()
            .expect("outside filename")
            .to_string_lossy()
            .as_ref(),
    );
    let result = remove_entry_files(&root, &[recorded.to_string_lossy().into_owned()]).await;

    assert!(result.is_err());
    assert_eq!(
        fs::read(&outside).expect("read outside file"),
        b"must survive"
    );
    fs::remove_file(outside).expect("remove outside test file");
    fs::remove_dir_all(root).expect("remove temporary directory");
}

#[tokio::test]
async fn missing_recorded_file_is_already_deleted() {
    let root = temp_dir("missing-delete");
    let missing = root.join("already-gone.mkv");

    remove_entry_files(&root, &[missing.to_string_lossy().into_owned()])
        .await
        .expect("missing file is idempotently removed");

    fs::remove_dir_all(root).expect("remove temporary directory");
}

async fn fixture_state(
    root: &std::path::Path,
    fail_delete: bool,
) -> (BridgeState, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let rqbit_port = listener.local_addr().unwrap().port();
    let app = Router::new()
        .route(
            "/torrents",
            get(|| async { Json(json!({"torrents": [{"id": 1, "info_hash": "fixture"}]})) }),
        )
        .route(
            "/torrents/{id}/delete",
            post(move || async move {
                if fail_delete {
                    StatusCode::INTERNAL_SERVER_ERROR
                } else {
                    StatusCode::OK
                }
            }),
        );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let downloads = root.join("downloads");
    fs::create_dir_all(&downloads).unwrap();
    let store = CoreStore::load(root.join("state.json")).await.unwrap();
    let file = downloads.join("episode.mkv");
    fs::write(&file, b"download").unwrap();
    store
        .touch_cache(
            Some(1),
            "fixture".into(),
            None,
            None,
            vec![file.to_string_lossy().into_owned()],
        )
        .await
        .unwrap();
    let transcode = Arc::new(TranscodeManager::new());
    let piece_state = root.join("piece-state");
    fs::create_dir_all(&piece_state).unwrap();
    fs::write(piece_state.join("fixture.bitv"), b"pieces").unwrap();
    let sessions =
        crate::session::SessionManager::for_tests(root, transcode.clone(), store.clone()).await;
    let state = BridgeState {
        rqbit_port,
        token: "fixture-token".into(),
        client: reqwest::Client::new(),
        web_origin: None,
        allowed_hosts: Arc::new(StdRwLock::new(vec![])),
        bridge_port: 0,
        download_dir: Arc::new(RwLock::new(downloads.clone())),
        default_download_dir: downloads,
        cache_swap: Arc::new(RwLock::new(())),
        disk_pressure: Arc::new(AtomicBool::new(false)),
        store,
        transcode,
        subtitle_matches: Arc::new(Mutex::new(HashMap::new())),
        pairing: Arc::new(PairingManager::load(root).unwrap()),
        updater: Arc::new(UpdateManager::new()),
        sessions,
    };
    (state, server)
}

#[tokio::test]
async fn clear_removes_downloads_and_piece_records_before_forgetting_entries() {
    let root = temp_dir("clear-all");
    let (state, server) = fixture_state(&root, false).await;
    let downloads = state.current_download_dir().await;
    assert!(cache_size(downloads.clone()).await.unwrap() > 0);
    empty_cache(&state, &downloads).await.unwrap();
    assert_eq!(cache_size(downloads).await.unwrap(), 0);
    assert!(state.store.cache_snapshot().await.cache_entries.is_empty());
    assert!(!root.join("piece-state").exists());
    assert!(root.join("state.json").exists());
    server.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn failed_download_deletion_is_not_reported_as_success() {
    let root = temp_dir("clear-failure");
    let (state, server) = fixture_state(&root, true).await;
    let downloads = state.current_download_dir().await;
    assert!(empty_cache(&state, &downloads).await.is_err());
    assert_eq!(state.store.cache_snapshot().await.cache_entries.len(), 1);
    assert!(downloads.join("episode.mkv").exists());
    server.abort();
    fs::remove_dir_all(root).unwrap();
}
