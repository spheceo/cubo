//! `cubo update` and the y/n upgrade prompt shared by every command.
//!
//! Downloads `cubo-cli-<target-triple>.tar.gz` (+ its `.sha256`) from the
//! latest GitHub release, verifies the hash, and swaps the running binary.

use serde::{Deserialize, Serialize};

const REPO: &str = "spheceo/cubo";
const USER_AGENT: &str = concat!("cubo-cli/", env!("CARGO_PKG_VERSION"));
/// An "up to date" verdict is trusted for a day, so routine commands start
/// instantly instead of asking GitHub every run. `cubo update` always asks.
const CHECK_CACHE_SECONDS: u64 = 24 * 60 * 60;

#[derive(Serialize, Deserialize)]
struct CheckCache {
    checked_at: u64,
    up_to_date_version: String,
}

fn check_cache_path() -> std::path::PathBuf {
    cubo_engine::paths::data_dir().join("update-check.json")
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Like [`check_for_latest`], but remembers a recent "up to date" answer so
/// every `cubo serve` / `cubo search` does not pay for a network round-trip.
pub async fn check_for_latest_cached() -> Option<LatestRelease> {
    let fresh_verdict = std::fs::read(check_cache_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CheckCache>(&bytes).ok())
        .is_some_and(|cache| {
            cache.up_to_date_version == env!("CARGO_PKG_VERSION")
                && unix_seconds().saturating_sub(cache.checked_at) < CHECK_CACHE_SECONDS
        });
    if fresh_verdict {
        return None;
    }

    let latest = check_for_latest().await;
    if latest.is_none() {
        let cache = CheckCache {
            checked_at: unix_seconds(),
            up_to_date_version: env!("CARGO_PKG_VERSION").to_string(),
        };
        if let Ok(bytes) = serde_json::to_vec(&cache) {
            let path = check_cache_path();
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(path, bytes);
        }
    }
    latest
}

pub struct LatestRelease {
    pub tag: String,
    pub asset_name: String,
}

#[derive(Deserialize)]
struct ReleaseResponse {
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    tag_name: String,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
}

fn target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

fn current_version() -> (u64, u64, u64) {
    let mut parts = [0u64; 3];
    for (index, chunk) in env!("CARGO_PKG_VERSION").split('.').take(3).enumerate() {
        parts[index] = chunk.parse().unwrap_or(0);
    }
    (parts[0], parts[1], parts[2])
}

fn parse_tag_version(tag: &str) -> Option<(u64, u64, u64)> {
    let version = tag.strip_prefix('v').unwrap_or(tag);
    let mut parts = [0u64; 3];
    for (index, chunk) in version.split('.').take(3).enumerate() {
        parts[index] = chunk.parse().ok()?;
    }
    Some((parts[0], parts[1], parts[2]))
}

/// Returns details of a newer stable release when one exists.
pub async fn check_for_latest() -> Option<LatestRelease> {
    let client = reqwest::Client::new();
    let response = client
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        tracing::debug!("update check: releases endpoint returned {}", response.status());
        return None;
    }

    let release: ReleaseResponse = response.json().await.ok()?;
    if release.draft || release.prerelease {
        return None;
    }
    let latest = parse_tag_version(&release.tag_name)?;
    if latest <= current_version() {
        return None;
    }

    let wanted = format!("cubo-cli-{}.tar.gz", target_triple());
    let asset = release.assets.iter().find(|asset| asset.name == wanted)?;
    Some(LatestRelease {
        tag: release.tag_name,
        asset_name: asset.browser_download_url.clone(),
    })
}

pub async fn run() {
    match check_for_latest().await {
        None => {
            println!(
                "Cubo is up to date ({}).",
                env!("CARGO_PKG_VERSION")
            );
        }
        Some(release) => {
            println!("Updating Cubo to {}...", release.tag);
            if perform(&release.asset_name).await {
                println!("Done. Restart Cubo when you like.");
            }
        }
    }
}

/// Downloads and installs `asset_url`. Returns true on success. The running
/// process keeps its old image on disk until it exits; the swap lands for
/// the next launch.
pub async fn perform(asset_url: &str) -> bool {
    let Ok(exe_path) = std::env::current_exe() else {
        eprintln!("Update failed: could not locate the running binary.");
        return false;
    };
    let exe_dir = match exe_path.parent() {
        Some(dir) => dir.to_path_buf(),
        None => {
            eprintln!("Update failed: could not resolve the install directory.");
            return false;
        }
    };

    let client = reqwest::Client::new();

    let archive = match download(&client, asset_url).await {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("Update failed: download error ({error}).");
            return false;
        }
    };

    let checksum_url = format!("{asset_url}.sha256");
    let expected = match download(&client, &checksum_url).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes)
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_lowercase(),
        Err(_) => String::new(),
    };

    use sha2::{Digest, Sha256};
    let digest = hex::encode(Sha256::digest(&archive));
    if expected.is_empty() {
        eprintln!("Update failed: release has no checksum file; refusing to install.");
        return false;
    }
    if digest != expected {
        eprintln!("Update failed: checksum mismatch (expected {expected}, got {digest}).");
        return false;
    }

    // Extract the single `cubo` / `cubo.exe` entry from the archive.
    use std::io::Read as _;
    let decoder = flate2::read::GzDecoder::new(archive.as_slice());
    let mut archive = tar::Archive::new(decoder);
    let binary_name = if cfg!(windows) { "cubo.exe" } else { "cubo" };
    let mut payload: Option<Vec<u8>> = None;
    match archive.entries() {
        Ok(entries) => {
            for entry in entries.flatten() {
                let name = entry
                    .path()
                    .ok()
                    .and_then(|path| path.file_name().map(|name| name.to_owned()));
                if name.as_deref() == Some(std::ffi::OsStr::new(binary_name)) {
                    let mut buffer = Vec::new();
                    let mut entry = entry;
                    payload = entry
                        .read_to_end(&mut buffer)
                        .map(|_| buffer)
                        .ok();
                    break;
                }
            }
        }
        Err(error) => {
            eprintln!("Update failed: could not read the archive ({error}).");
            return false;
        }
    }
    let Some(payload) = payload else {
        eprintln!("Update failed: archive did not contain {binary_name}.");
        return false;
    };

    // Stage next to the real binary, then swap atomically where the OS allows.
    let staged = exe_dir.join(format!("{binary_name}.new"));
    if std::fs::write(&staged, &payload).is_err() {
        eprintln!("Update failed: could not write into {}", exe_dir.display());
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755));
        if std::fs::rename(&staged, &exe_path).is_err() {
            eprintln!("Update failed: could not replace the running binary.");
            let _ = std::fs::remove_file(&staged);
            return false;
        }
    }

    #[cfg(windows)]
    {
        let retired = exe_dir.join("cubo.old.exe");
        let _ = std::fs::remove_file(&retired);
        if std::fs::rename(&exe_path, &retired).is_err()
            || std::fs::rename(&staged, &exe_path).is_err()
        {
            eprintln!("Update failed: could not replace the running binary.");
            let _ = std::fs::remove_file(&staged);
            return false;
        }
    }

    true
}

async fn download(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| error.to_string())
}
