//! Local-peer integration coverage for the bounded rqbit storage factory.
//!
//! This test is intentionally opt-in: it starts two real rqbit sessions and
//! exercises the same peer protocol used by Core. Run it with
//! `cargo test -p cubo-engine rolling_cache_local_peer -- --ignored`.

use std::{
    fs,
    io::SeekFrom,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{Context, Result};
use librqbit::storage::StorageFactoryExt;
use librqbit::{
    create_torrent, spawn_utils::BlockingSpawner, AddTorrent, AddTorrentOptions,
    CreateTorrentOptions, Session, SessionOptions,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use uuid::Uuid;

use crate::rolling_cache::RollingCache;

const SOURCE_BYTES: usize = 16 * 1024 * 1024;
const PIECE_BYTES: u32 = 256 * 1024;
const CACHE_BYTES: u64 = 2 * 1024 * 1024;

fn test_root() -> PathBuf {
    std::env::temp_dir().join(format!("cubo-rqbit-cache-{}", Uuid::new_v4()))
}

fn deterministic_bytes(offset: usize, length: usize) -> Vec<u8> {
    (0..length)
        .map(|index| {
            let value = offset.wrapping_add(index);
            (value as u32)
                .wrapping_mul(0x45d9f3b)
                .rotate_left((value % 31) as u32) as u8
        })
        .collect()
}

fn directory_bytes(root: &Path) -> u64 {
    let mut total = 0;
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            total += directory_bytes(&path);
        } else if let Ok(metadata) = fs::metadata(path) {
            total += allocated_bytes(&metadata);
        }
    }
    total
}

#[cfg(unix)]
fn allocated_bytes(metadata: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.blocks().saturating_mul(512)
}

#[cfg(not(unix))]
fn allocated_bytes(metadata: &fs::Metadata) -> u64 {
    metadata.len()
}

fn session_options(storage: Option<RollingCache>, listen_addr: SocketAddr) -> SessionOptions {
    SessionOptions {
        dht: None,
        disable_trackers: true,
        disable_local_service_discovery: true,
        persistence: None,
        ipv4_only: true,
        listen: Some(librqbit::ListenerOptions {
            listen_addr,
            ..Default::default()
        }),
        default_storage_factory: storage.map(|cache| cache.boxed()),
        ..Default::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "starts local rqbit peers"]
async fn rolling_cache_local_peer_streams_forward_and_back_within_budget() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("librqbit=debug")
        .with_test_writer()
        .try_init();
    let root = test_root();
    let seed_root = root.join("seed");
    let client_root = root.join("client");
    fs::create_dir_all(&seed_root)?;
    fs::create_dir_all(&client_root)?;

    let source = seed_root.join("fixture.bin");
    let mut contents = Vec::with_capacity(SOURCE_BYTES);
    for offset in (0..SOURCE_BYTES).step_by(64 * 1024) {
        contents.extend(deterministic_bytes(
            offset,
            (SOURCE_BYTES - offset).min(64 * 1024),
        ));
    }
    fs::write(&source, &contents)?;

    let torrent = create_torrent(
        &seed_root,
        CreateTorrentOptions {
            name: Some("cubo-cache-fixture"),
            piece_length: Some(PIECE_BYTES),
            ..Default::default()
        },
        &BlockingSpawner::new(2),
    )
    .await
    .context("create fixture torrent")?;
    let torrent_bytes = torrent.as_bytes()?;

    let seeder = Session::new_with_opts(
        seed_root.clone(),
        session_options(None, (Ipv4Addr::LOCALHOST, 0).into()),
    )
    .await
    .context("start seeder")?;
    let seed_handle = seeder
        .add_torrent(
            AddTorrent::from_bytes(torrent_bytes.clone()),
            Some(AddTorrentOptions {
                paused: false,
                overwrite: true,
                output_folder: Some(seed_root.to_string_lossy().into_owned()),
                ..Default::default()
            }),
        )
        .await?
        .into_handle()
        .context("seeder handle")?;
    tokio::time::timeout(Duration::from_secs(30), seed_handle.wait_until_completed())
        .await
        .context("seeder timeout")??;
    let peer = seeder.listen_addr().context("seeder listen address")?;

    let cache = RollingCache::new(client_root.clone(), CACHE_BYTES)?;
    let client = Session::new_with_opts(
        client_root.clone(),
        session_options(Some(cache.clone()), (Ipv4Addr::LOCALHOST, 0).into()),
    )
    .await
    .context("start downloader")?;
    let handle = client
        .add_torrent(
            AddTorrent::from_bytes(torrent_bytes),
            Some(AddTorrentOptions {
                paused: false,
                initial_peers: Some(vec![peer]),
                ..Default::default()
            }),
        )
        .await?
        .into_handle()
        .context("downloader handle")?;
    handle.wait_until_initialized().await?;

    let peak = Arc::new(AtomicU64::new(0));
    let sampler_peak = peak.clone();
    let sampler_root = client_root.clone();
    let sampler = tokio::spawn(async move {
        loop {
            sampler_peak.fetch_max(directory_bytes(&sampler_root), Ordering::Relaxed);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    });

    let mut stream = handle.clone().stream(0).await?;
    let mut received = Vec::with_capacity(SOURCE_BYTES);
    let mut chunk = vec![0; 256 * 1024];
    while received.len() < SOURCE_BYTES {
        let before = received.len();
        let count = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk))
            .await
            .with_context(|| format!("forward stream timeout at byte {before}"))??;
        if count == 0 {
            anyhow::bail!("forward stream ended at byte {before}");
        }
        received.extend_from_slice(&chunk[..count]);
        eprintln!(
            "rolling-cache forward: {}/{} bytes, allocated={} bytes",
            received.len(),
            SOURCE_BYTES,
            directory_bytes(&client_root),
        );
    }
    assert_eq!(received, contents, "forward stream bytes differ");

    stream.seek(SeekFrom::Start(0)).await?;
    let mut prefix = vec![0; PIECE_BYTES as usize];
    tokio::time::timeout(Duration::from_secs(30), stream.read_exact(&mut prefix))
        .await
        .context("backward stream timeout")??;
    assert_eq!(
        &prefix,
        &contents[..prefix.len()],
        "evicted prefix did not refill correctly"
    );
    sampler.abort();
    assert!(
        peak.load(Ordering::Relaxed) <= CACHE_BYTES,
        "cache exceeded budget"
    );

    drop(stream);
    drop(handle);
    client.stop().await;
    drop(client);
    drop(seed_handle);
    seeder.stop().await;
    drop(seeder);
    fs::remove_dir_all(root)?;
    Ok(())
}
