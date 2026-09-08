//! In-process CLI updater: check GitHub, stage a release, then swap the
//! running binary. The web UI starts download then apply as one action;
//! GET /v1/update reports byte progress while the archive streams in.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const REPO: &str = "spheceo/cubo";
const USER_AGENT: &str = concat!("cubo-cli/", env!("CARGO_PKG_VERSION"));
const CHECK_CACHE_SECONDS: u64 = 24 * 60 * 60;
/// "You're current" must not hide a release that lands later the same day.
const NEGATIVE_CHECK_CACHE_SECONDS: u64 = 10 * 60;
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    Idle,
    Downloading,
    Ready,
    Applying,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub latest: Option<String>,
    pub state: UpdatePhase,
    pub error: Option<String>,
    /// 0–1 while a release is streaming in. 1 once staged or applying.
    #[serde(default)]
    pub progress: f64,
}

#[derive(Clone)]
pub struct LatestRelease {
    pub tag: String,
    pub asset_url: String,
}

#[derive(Serialize, Deserialize)]
struct CheckCache {
    checked_at: u64,
    current_version: String,
    latest: Option<String>,
    asset_url: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StageManifest {
    tag: String,
    asset_url: String,
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

struct Inner {
    latest: Option<LatestRelease>,
    state: UpdatePhase,
    error: Option<String>,
}

pub struct UpdateManager {
    inner: Mutex<Inner>,
    applying: AtomicBool,
    /// Thousandths of completion so status() can read progress without
    /// waiting on the download lock.
    progress_millis: AtomicU32,
}

impl Default for UpdateManager {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdateManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                latest: read_staged_release(),
                state: if staged_binary().is_some() {
                    UpdatePhase::Ready
                } else {
                    UpdatePhase::Idle
                },
                error: None,
            }),
            applying: AtomicBool::new(false),
            progress_millis: AtomicU32::new(0),
        }
    }

    fn set_progress(&self, progress: f64) {
        let millis = (progress.clamp(0.0, 1.0) * 1000.0).round() as u32;
        self.progress_millis.store(millis, Ordering::Release);
    }

    pub async fn status(&self) -> UpdateStatus {
        if self.applying.load(Ordering::Acquire) {
            let inner = self.inner.lock().await;
            return UpdateStatus {
                current: current_version_string(),
                latest: inner
                    .latest
                    .as_ref()
                    .map(|release| release.tag.clone())
                    .or_else(read_staged_tag),
                state: UpdatePhase::Applying,
                error: None,
                progress: 1.0,
            };
        }

        {
            let inner = self.inner.lock().await;
            if inner.state == UpdatePhase::Downloading {
                return self.snapshot(&inner);
            }
        }

        let latest = match check_for_latest_cached().await {
            Ok(value) => value,
            Err(error) => {
                let mut inner = self.inner.lock().await;
                if inner.state == UpdatePhase::Idle {
                    inner.error = Some(error);
                }
                inner.latest.clone()
            }
        };
        let mut inner = self.inner.lock().await;
        if let Some(latest) = latest {
            inner.latest = Some(latest);
        } else if inner.state != UpdatePhase::Ready {
            inner.latest = None;
        }
        if inner.state == UpdatePhase::Ready && staged_binary().is_none() {
            inner.state = UpdatePhase::Idle;
        }
        if inner.state == UpdatePhase::Idle && staged_matches(inner.latest.as_ref()) {
            inner.state = UpdatePhase::Ready;
        }
        self.snapshot(&inner)
    }

    pub async fn download(&self) -> Result<UpdateStatus, String> {
        if self.applying.load(Ordering::Acquire) {
            return Ok(self.status().await);
        }

        loop {
            let state = self.inner.lock().await.state;
            if state != UpdatePhase::Downloading {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        {
            let inner = self.inner.lock().await;
            if inner.state == UpdatePhase::Ready && staged_binary().is_some() {
                self.set_progress(1.0);
                return Ok(self.snapshot(&inner));
            }
        }

        {
            let mut inner = self.inner.lock().await;
            inner.state = UpdatePhase::Downloading;
            inner.error = None;
        }
        self.set_progress(0.0);

        let latest = match check_for_latest().await {
            Ok(Some(latest)) => latest,
            Ok(None) => {
                let mut inner = self.inner.lock().await;
                inner.latest = None;
                inner.state = UpdatePhase::Idle;
                inner.error = None;
                self.set_progress(0.0);
                return Ok(self.snapshot(&inner));
            }
            Err(error) => {
                let mut inner = self.inner.lock().await;
                inner.state = UpdatePhase::Idle;
                inner.error = Some(error.clone());
                self.set_progress(0.0);
                return Err(error);
            }
        };
        {
            let mut inner = self.inner.lock().await;
            inner.latest = Some(LatestRelease {
                tag: latest.tag.clone(),
                asset_url: latest.asset_url.clone(),
            });
            if staged_matches(Some(&latest)) {
                inner.state = UpdatePhase::Ready;
                inner.error = None;
                self.set_progress(1.0);
                return Ok(self.snapshot(&inner));
            }
            inner.state = UpdatePhase::Downloading;
            inner.error = None;
        }
        match stage_release(&latest, |fraction| self.set_progress(fraction)).await {
            Ok(()) => {
                let mut inner = self.inner.lock().await;
                inner.state = UpdatePhase::Ready;
                inner.error = None;
                self.set_progress(1.0);
                Ok(self.snapshot(&inner))
            }
            Err(error) => {
                let mut inner = self.inner.lock().await;
                inner.state = UpdatePhase::Idle;
                inner.error = Some(error.clone());
                self.set_progress(0.0);
                Err(error)
            }
        }
    }

    pub async fn apply(&self) -> Result<UpdateStatus, String> {
        if self.applying.swap(true, Ordering::AcqRel) {
            return Ok(self.status().await);
        }
        let latest = {
            let mut inner = self.inner.lock().await;
            inner.state = UpdatePhase::Applying;
            inner.error = None;
            inner.latest.clone()
        };
        let Some(latest) = latest.filter(|_| staged_binary().is_some()) else {
            self.applying.store(false, Ordering::Release);
            let mut inner = self.inner.lock().await;
            inner.state = UpdatePhase::Idle;
            inner.error = Some("Download the update before installing it.".into());
            return Err("Download the update before installing it.".into());
        };
        if let Err(error) = install_staged() {
            self.applying.store(false, Ordering::Release);
            let mut inner = self.inner.lock().await;
            inner.state = UpdatePhase::Ready;
            inner.error = Some(error.clone());
            return Err(error);
        }
        tracing::info!(target: "update", tag = %latest.tag, "staged update installed; restarting");
        tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            relaunch_or_exit();
        });
        self.set_progress(1.0);
        Ok(UpdateStatus {
            current: current_version_string(),
            latest: Some(latest.tag),
            state: UpdatePhase::Applying,
            error: None,
            progress: 1.0,
        })
    }

    fn snapshot(&self, inner: &Inner) -> UpdateStatus {
        UpdateStatus {
            current: current_version_string(),
            latest: inner.latest.as_ref().map(|release| release.tag.clone()),
            state: inner.state,
            error: inner.error.clone(),
            progress: self.progress_millis.load(Ordering::Acquire) as f64 / 1000.0,
        }
    }
}

/// Like [`check_for_latest`], but remembers a recent "up to date" / "this
/// tag is newest" answer so routine polls do not hit GitHub every time.
pub async fn check_for_latest_cached() -> Result<Option<LatestRelease>, String> {
    if let Some(cached) = read_fresh_cache() {
        return Ok(cached);
    }
    let latest = check_for_latest().await?;
    write_check_cache(latest.as_ref());
    Ok(latest)
}

/// Returns details of a newer stable release when one exists.
pub async fn check_for_latest() -> Result<Option<LatestRelease>, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| format!("could not check for updates ({error})"))?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub releases returned {}",
            response.status()
        ));
    }

    let release: ReleaseResponse = response
        .json()
        .await
        .map_err(|error| format!("unexpected GitHub release payload ({error})"))?;
    if release.draft || release.prerelease {
        return Ok(None);
    }
    let latest = parse_tag_version(&release.tag_name)
        .ok_or_else(|| format!("unreadable release tag {}", release.tag_name))?;
    if latest <= current_version() {
        return Ok(None);
    }

    let wanted = format!("cubo-cli-{}.tar.gz", target_triple());
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == wanted)
        .ok_or_else(|| format!("release {} has no {wanted}", release.tag_name))?;
    Ok(Some(LatestRelease {
        tag: release.tag_name,
        asset_url: asset.browser_download_url.clone(),
    }))
}

/// One-shot CLI path: download, install, leave relaunch to the caller.
pub async fn perform(tag: &str, asset_url: &str) -> bool {
    let release = LatestRelease {
        tag: tag.to_owned(),
        asset_url: asset_url.to_owned(),
    };
    if let Err(error) = stage_release(&release, |_| {}).await {
        eprintln!("Update failed: {error}");
        return false;
    }
    if let Err(error) = install_staged() {
        eprintln!("Update failed: {error}");
        return false;
    }
    true
}

fn current_version_string() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn current_version() -> (u64, u64, u64) {
    parse_tag_version(env!("CARGO_PKG_VERSION")).unwrap_or((0, 0, 0))
}

fn parse_tag_version(tag: &str) -> Option<(u64, u64, u64)> {
    let version = tag.strip_prefix('v').unwrap_or(tag);
    let mut parts = [0u64; 3];
    for (index, chunk) in version.split('.').take(3).enumerate() {
        parts[index] = chunk.parse().ok()?;
    }
    Some((parts[0], parts[1], parts[2]))
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

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn check_cache_path() -> PathBuf {
    crate::paths::data_dir().join("update-check.json")
}

fn stage_dir() -> PathBuf {
    crate::paths::data_dir().join("updates").join("staged")
}

fn read_fresh_cache() -> Option<Option<LatestRelease>> {
    let cache = serde_json::from_slice::<CheckCache>(&std::fs::read(check_cache_path()).ok()?)
        .ok()?;
    if cache.current_version != env!("CARGO_PKG_VERSION") {
        return None;
    }
    if unix_seconds().saturating_sub(cache.checked_at) >= cache_ttl(&cache) {
        return None;
    }
    match (cache.latest, cache.asset_url) {
        (Some(tag), Some(asset_url)) => Some(Some(LatestRelease { tag, asset_url })),
        (None, _) => Some(None),
        _ => None,
    }
}

fn cache_ttl(cache: &CheckCache) -> u64 {
    if cache.latest.is_none() {
        NEGATIVE_CHECK_CACHE_SECONDS
    } else {
        CHECK_CACHE_SECONDS
    }
}

fn write_check_cache(latest: Option<&LatestRelease>) {
    let cache = CheckCache {
        checked_at: unix_seconds(),
        current_version: current_version_string(),
        latest: latest.map(|release| release.tag.clone()),
        asset_url: latest.map(|release| release.asset_url.clone()),
    };
    if let Ok(bytes) = serde_json::to_vec(&cache) {
        let path = check_cache_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, bytes);
    }
}

fn read_staged_tag() -> Option<String> {
    read_staged_release().map(|release| release.tag)
}

fn read_staged_release() -> Option<LatestRelease> {
    let bytes = std::fs::read(stage_dir().join("manifest.json")).ok()?;
    let manifest = serde_json::from_slice::<StageManifest>(&bytes).ok()?;
    staged_binary()?;
    Some(LatestRelease {
        tag: manifest.tag,
        asset_url: manifest.asset_url,
    })
}

fn staged_matches(latest: Option<&LatestRelease>) -> bool {
    match (latest, read_staged_release()) {
        (Some(latest), Some(staged)) => latest.tag == staged.tag,
        _ => false,
    }
}

fn binary_name() -> &'static str {
    if cfg!(windows) { "cubo.exe" } else { "cubo" }
}

fn sidecar_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["ffmpeg.exe", "ffprobe.exe"]
    } else {
        &["ffmpeg", "ffprobe"]
    }
}

fn staged_binary() -> Option<PathBuf> {
    let path = stage_dir().join(binary_name());
    path.is_file().then_some(path)
}

async fn stage_release(release: &LatestRelease, report: impl Fn(f64)) -> Result<(), String> {
    let client = reqwest::Client::new();
    report(0.0);
    let archive = download_body(&client, &release.asset_url, |fraction| report(fraction * 0.9)).await?;
    report(0.9);
    let checksum_url = format!("{}.sha256", release.asset_url);
    let expected = download_body(&client, &checksum_url, |_| {})
        .await
        .ok()
        .and_then(|bytes| {
            String::from_utf8_lossy(&bytes)
                .split_whitespace()
                .next()
                .map(|value| value.to_lowercase())
        })
        .unwrap_or_default();
    if expected.is_empty() {
        return Err("release has no checksum file; refusing to install".into());
    }
    report(0.94);
    use sha2::{Digest, Sha256};
    let digest = hex::encode(Sha256::digest(&archive));
    if digest != expected {
        return Err(format!(
            "checksum mismatch (expected {expected}, got {digest})"
        ));
    }
    report(0.96);

    let dir = stage_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create update stage ({error})"))?;

    extract_release_files(&archive, &dir)?;
    if !dir.join(binary_name()).is_file() {
        return Err(format!("archive did not contain {}", binary_name()));
    }
    let manifest = StageManifest {
        tag: release.tag.clone(),
        asset_url: release.asset_url.clone(),
    };
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("could not write update manifest ({error})"))?;
    report(1.0);
    Ok(())
}

fn extract_release_files(archive: &[u8], dir: &Path) -> Result<(), String> {
    use std::io::Read as _;
    let decoder = flate2::read::GzDecoder::new(archive);
    let mut archive = tar::Archive::new(decoder);
    let wanted: Vec<&str> = std::iter::once(binary_name())
        .chain(sidecar_names().iter().copied())
        .collect();
    let entries = archive
        .entries()
        .map_err(|error| format!("could not read the archive ({error})"))?;
    for entry in entries.flatten() {
        let name = entry
            .path()
            .ok()
            .and_then(|path| path.file_name().map(|name| name.to_owned()));
        let Some(name) = name else { continue };
        if !wanted.iter().any(|wanted| name == std::ffi::OsStr::new(wanted)) {
            continue;
        }
        let mut buffer = Vec::new();
        let mut entry = entry;
        entry
            .read_to_end(&mut buffer)
            .map_err(|error| format!("could not extract {} ({error})", name.to_string_lossy()))?;
        let dest = dir.join(&name);
        std::fs::write(&dest, buffer)
            .map_err(|error| format!("could not stage {} ({error})", name.to_string_lossy()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
        }
    }
    Ok(())
}

fn install_staged() -> Result<(), String> {
    let exe_path = std::env::current_exe()
        .map_err(|_| "could not locate the running binary".to_string())?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "could not resolve the install directory".to_string())?
        .to_path_buf();
    let staged = stage_dir();
    replace_file(&staged.join(binary_name()), &exe_path)?;
    for name in sidecar_names() {
        let source = staged.join(name);
        if source.is_file() {
            let _ = replace_file(&source, &exe_dir.join(name));
        }
    }
    Ok(())
}

fn replace_file(source: &Path, dest: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::rename(source, dest).map_err(|error| {
            format!("could not replace {} ({error})", dest.display())
        })?;
        Ok(())
    }

    #[cfg(windows)]
    {
        if dest.exists() {
            let retired = dest.with_extension("old.exe");
            let _ = std::fs::remove_file(&retired);
            std::fs::rename(dest, &retired).map_err(|error| {
                format!("could not retire {} ({error})", dest.display())
            })?;
        }
        std::fs::rename(source, dest).map_err(|error| {
            format!("could not replace {} ({error})", dest.display())
        })?;
        Ok(())
    }
}

fn launched_by_supervisor() -> bool {
    if std::env::var_os("CUBO_PERSIST").is_some() {
        return true;
    }
    if cfg!(target_os = "macos") {
        return std::env::var("XPC_SERVICE_NAME")
            .is_ok_and(|value| value.contains("com.spheceo.cubo"));
    }
    if cfg!(target_os = "linux") {
        return std::env::var_os("INVOCATION_ID").is_some();
    }
    false
}

fn relaunch_or_exit() -> ! {
    if !launched_by_supervisor() {
        let exe = std::env::current_exe().ok();
        let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
        if let Some(exe) = exe {
            spawn_delayed_relaunch(&exe, &args);
        }
    }
    std::process::exit(0);
}

fn spawn_delayed_relaunch(exe: &Path, args: &[std::ffi::OsString]) {
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("sh")
            .arg("-c")
            .arg("sleep 0.5; exec \"$0\" \"$@\"")
            .arg(exe)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }

    #[cfg(windows)]
    {
        let mut cmdline = format!("timeout /T 1 /NOBREAK >NUL & \"{}\"", exe.display());
        for arg in args {
            cmdline.push_str(&format!(" \"{}\"", arg.to_string_lossy()));
        }
        let _ = std::process::Command::new("cmd")
            .arg("/C")
            .arg(cmdline)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

async fn download_body(
    client: &reqwest::Client,
    url: &str,
    mut report: impl FnMut(f64),
) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let total = response.content_length();
    let mut body = Vec::new();
    if let Some(total) = total {
        body.reserve(usize::try_from(total.min(80 * 1024 * 1024)).unwrap_or(0));
    }
    let mut stream = response.bytes_stream();
    let mut last_report = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        body.extend_from_slice(&chunk);
        let downloaded = body.len() as u64;
        if let Some(total) = total.filter(|total| *total > 0) {
            if downloaded == total || downloaded.saturating_sub(last_report) >= 256 * 1024 {
                last_report = downloaded;
                report((downloaded as f64 / total as f64).min(1.0));
            }
        }
    }
    report(1.0);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_parsing_strips_the_v_prefix() {
        assert_eq!(parse_tag_version("v0.0.9"), Some((0, 0, 9)));
        assert_eq!(parse_tag_version("0.1.0"), Some((0, 1, 0)));
        assert!(parse_tag_version("v0.0.9") < parse_tag_version("v0.0.10"));
        assert!(parse_tag_version("not-a-version").is_none());
    }

    #[test]
    fn status_defaults_to_the_running_crate_version() {
        let manager = UpdateManager::new();
        assert!(!manager.applying.load(Ordering::Acquire));
        assert_eq!(current_version_string(), env!("CARGO_PKG_VERSION"));
        assert_eq!(manager.progress_millis.load(Ordering::Acquire), 0);
    }

    #[test]
    fn progress_stores_thousandths() {
        let manager = UpdateManager::new();
        manager.set_progress(0.42);
        assert_eq!(manager.progress_millis.load(Ordering::Acquire), 420);
        manager.set_progress(1.5);
        assert_eq!(manager.progress_millis.load(Ordering::Acquire), 1000);
    }

    #[test]
    fn up_to_date_checks_expire_faster_than_known_updates() {
        let negative = CheckCache {
            checked_at: 0,
            current_version: "0.0.10".into(),
            latest: None,
            asset_url: None,
        };
        let positive = CheckCache {
            checked_at: 0,
            current_version: "0.0.10".into(),
            latest: Some("v0.0.11".into()),
            asset_url: Some("https://example.invalid/cubo.tar.gz".into()),
        };
        assert_eq!(cache_ttl(&negative), 10 * 60);
        assert_eq!(cache_ttl(&positive), 24 * 60 * 60);
    }
}
