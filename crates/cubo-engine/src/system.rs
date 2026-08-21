//! System resource snapshot for the `/v1/system` endpoint. Lets the web UI
//! show what the Core machine is doing (storage, memory, CPU) from
//! the advanced panel in the library page.
//!
//! GPU reporting is best-effort: there is no portable Rust API, so we query
//! nvidia-smi when present and otherwise report the adapter name only.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    pub storage: StorageStats,
    pub memory: MemoryStats,
    pub cpu: CpuStats,
    pub gpu: GpuStats,
    pub uptime_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    /// Total size of the volume holding the download directory.
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub free_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CpuStats {
    /// Overall usage percentage, 0-100.
    pub usage_percent: f32,
    pub core_count: usize,
    pub brand: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GpuStats {
    /// Adapter names; empty when none can be detected on this platform.
    pub adapters: Vec<String>,
    /// Usage percentages aligned with `adapters` where the driver exposes it.
    pub usage_percent: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub path: String,
    pub folders: Vec<FolderInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub name: String,
    pub path: String,
    pub has_folders: bool,
    pub has_files: bool,
}

/// Lists immediate child folders only. File names and contents are never
/// returned — we only look at `file_type` so the picker can hide files and
/// disable folders that already contain any.
pub fn list_folders(path: Option<&str>) -> Result<FolderListing, String> {
    match path {
        None | Some("") => Ok(FolderListing {
            path: String::new(),
            folders: root_folders(),
        }),
        Some(raw) => list_child_folders(Path::new(raw)),
    }
}

/// Creates one new folder under an existing parent. The name cannot contain
/// path separators; we never create intermediate directories.
pub fn create_folder(parent: &str, name: &str) -> Result<FolderInfo, String> {
    let parent = Path::new(parent);
    if !parent.is_absolute() {
        return Err("Pick a folder first.".into());
    }
    if skip_browse_path(parent) || skip_mount(parent) {
        return Err("Cannot create a folder there.".into());
    }
    let name = sanitize_folder_name(name)?;
    if !parent.is_dir() {
        return Err("That parent folder does not exist.".into());
    }
    let path = parent.join(&name);
    if path.exists() {
        return Err("A folder with that name already exists.".into());
    }
    std::fs::create_dir(&path).map_err(|error| format!("Could not create that folder: {error}"))?;
    folder_info(&path).ok_or_else(|| "Created the folder, but could not read it back.".into())
}

fn sanitize_folder_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("Enter a folder name.".into());
    }
    if name == "." || name == ".." {
        return Err("That folder name is not allowed.".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("The folder name cannot contain slashes.".into());
    }
    if name.len() > 200 {
        return Err("That folder name is too long.".into());
    }
    Ok(name.to_owned())
}

/// True when `path` contains any regular file at any depth. Used to refuse
/// a cache target that already holds user data. File names are not collected.
pub fn folder_contains_files(path: &Path) -> Result<bool, String> {
    const WALK_CAP: usize = 10_000;
    let mut stack = vec![path.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > WALK_CAP {
                return Ok(true);
            }
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_file() {
                return Ok(true);
            }
            if file_type.is_dir() && !file_type.is_symlink() {
                stack.push(entry.path());
            }
        }
    }
    Ok(false)
}

fn root_folders() -> Vec<FolderInfo> {
    let mut folders = Vec::new();
    let mut seen = std::collections::HashSet::new();

    if let Some(home) = crate::paths::home_dir() {
        if let Some(info) = folder_info(&home) {
            seen.insert(info.path.clone());
            folders.push(info);
        }
    }

    for disk in sysinfo::Disks::new_with_refreshed_list().list() {
        let mount = disk.mount_point();
        if skip_mount(mount) {
            continue;
        }
        if let Some(info) = folder_info(mount) {
            if seen.insert(info.path.clone()) {
                folders.push(info);
            }
        }
    }

    folders.sort_by(|left, right| left.name.to_ascii_lowercase().cmp(&right.name.to_ascii_lowercase()));
    folders
}

fn list_child_folders(path: &Path) -> Result<FolderListing, String> {
    if !path.is_absolute() {
        return Err("Folder path must be absolute.".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not open that folder: {error}"))?;
    if !canonical.is_dir() {
        return Err("That path is not a folder.".into());
    }

    let mut folders = Vec::new();
    let entries = std::fs::read_dir(&canonical)
        .map_err(|error| format!("Could not read that folder: {error}"))?;
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let child = entry.path();
        if skip_browse_path(&child) {
            continue;
        }
        if let Some(info) = folder_info(&child) {
            folders.push(info);
        }
    }
    folders.sort_by(|left, right| left.name.to_ascii_lowercase().cmp(&right.name.to_ascii_lowercase()));
    Ok(FolderListing {
        path: canonical.to_string_lossy().into_owned(),
        folders,
    })
}

fn folder_info(path: &Path) -> Option<FolderInfo> {
    if !path.is_dir() {
        return None;
    }
    let (has_folders, has_files) = inspect_folder(path);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    Some(FolderInfo {
        name,
        path: path.to_string_lossy().into_owned(),
        has_folders,
        has_files,
    })
}

fn inspect_folder(path: &Path) -> (bool, bool) {
    let mut has_folders = false;
    let mut has_files = false;
    let Ok(entries) = std::fs::read_dir(path) else {
        return (false, false);
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() && !file_type.is_symlink() {
            has_folders = true;
        } else if file_type.is_file() {
            has_files = true;
        }
        if has_folders && has_files {
            break;
        }
    }
    (has_folders, has_files)
}

fn skip_mount(path: &Path) -> bool {
    let text = path.to_string_lossy();
    text == "/dev" || text.starts_with("/dev/") || text == "/proc" || text == "/sys"
}

fn skip_browse_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    matches!(
        name,
        "dev" | "proc" | "sys" | "run" | "$Recycle.Bin" | "System Volume Information"
    )
}

/// CPU sampling needs two refreshes separated by a short interval to produce
/// a meaningful usage percentage, so this takes ~250ms by design.
pub fn snapshot(download_dir: &Path) -> SystemSnapshot {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.refresh_cpu_usage();

    // Second sample after a beat so global_cpu_usage has a delta to work with.
    std::thread::sleep(std::time::Duration::from_millis(250));
    sys.refresh_memory();
    sys.refresh_cpu_usage();

    let memory = MemoryStats {
        total_bytes: sys.total_memory(),
        used_bytes: sys.used_memory(),
        free_bytes: sys.available_memory(),
    };

    let cpu = CpuStats {
        usage_percent: sys.global_cpu_usage().max(0.0),
        core_count: sys.cpus().len(),
        brand: sys
            .cpus()
            .first()
            .map(|cpu| cpu.brand().trim().to_string())
            .unwrap_or_default(),
    };

    let storage = storage_stats(download_dir);
    let gpu = gpu_stats();

    SystemSnapshot {
        storage,
        memory,
        cpu,
        gpu,
        uptime_seconds: sysinfo::System::uptime(),
    }
}

fn storage_stats(download_dir: &Path) -> StorageStats {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let probe = nearest_existing_parent(download_dir);
    let mut best: Option<(usize, &sysinfo::Disk)> = None;
    for disk in disks.list() {
        if !probe.starts_with(disk.mount_point()) {
            continue;
        }
        let specificity = disk.mount_point().components().count();
        if best.is_none_or(|(best_depth, _)| specificity > best_depth) {
            best = Some((specificity, disk));
        }
    }

    match best {
        Some((_, disk)) => StorageStats {
            total_bytes: disk.total_space(),
            free_bytes: disk.available_space(),
        },
        None => StorageStats::default(),
    }
}

/// The download directory may not exist yet on a fresh install; walk up until
/// we find a path that does so volume matching still works.
fn nearest_existing_parent(path: &Path) -> std::borrow::Cow<'_, Path> {
    let mut current = path;
    loop {
        if current.exists() {
            return std::borrow::Cow::Borrowed(current);
        }
        match current.parent() {
            Some(parent) => current = parent,
            None => return std::borrow::Cow::Borrowed(path),
        }
    }
}

fn gpu_stats() -> GpuStats {
    #[cfg(target_os = "macos")]
    {
        // macOS has no CLI GPU utilisation source that is fast and reliable;
        // report nothing rather than shelling out to system_profiler (slow).
        GpuStats::default()
    }

    #[cfg(not(target_os = "macos"))]
    {
        let output = std::process::Command::new("nvidia-smi")
            .args(["--query-gpu=name,utilization.gpu", "--format=csv,noheader,nounits"])
            .output();
        match output {
            Ok(output) if output.status.success() => {
                let text = String::from_utf8_lossy(&output.stdout);
                let mut adapters = Vec::new();
                let mut usage = Vec::new();
                for line in text.lines() {
                    let mut parts = line.splitn(2, ',');
                    let name = parts.next().unwrap_or("").trim();
                    if name.is_empty() {
                        continue;
                    }
                    adapters.push(name.to_string());
                    usage.push(
                        parts
                            .next()
                            .and_then(|value| value.trim().parse::<f32>().ok())
                            .unwrap_or(0.0),
                    );
                }
                GpuStats { adapters, usage_percent: usage }
            }
            _ => GpuStats::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{folder_contains_files, list_folders};
    use std::fs;

    #[test]
    fn folder_listing_omits_files_and_flags_occupied_dirs() {
        let root = std::env::temp_dir().join(format!(
            "cubo-folders-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let empty = root.join("empty");
        let occupied = root.join("occupied");
        let nested = occupied.join("child");
        fs::create_dir_all(&empty).unwrap();
        fs::create_dir_all(&nested).unwrap();
        fs::write(occupied.join("secret.bin"), b"nope").unwrap();

        let listing = list_folders(Some(root.to_str().unwrap())).unwrap();
        let names: Vec<_> = listing.folders.iter().map(|folder| folder.name.as_str()).collect();
        assert_eq!(names, ["empty", "occupied"]);
        let empty_info = listing
            .folders
            .iter()
            .find(|folder| folder.name == "empty")
            .unwrap();
        let occupied_info = listing
            .folders
            .iter()
            .find(|folder| folder.name == "occupied")
            .unwrap();
        assert!(!empty_info.has_files);
        assert!(!empty_info.has_folders);
        assert!(occupied_info.has_files);
        assert!(occupied_info.has_folders);
        assert!(!folder_contains_files(&empty).unwrap());
        assert!(folder_contains_files(&occupied).unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_folder_makes_an_empty_child() {
        let root = std::env::temp_dir().join(format!(
            "cubo-create-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let created = super::create_folder(root.to_str().unwrap(), "Cubo Cache").unwrap();
        assert_eq!(created.name, "Cubo Cache");
        assert!(!created.has_files);
        assert!(super::create_folder(root.to_str().unwrap(), "Cubo Cache").is_err());
        assert!(super::create_folder(root.to_str().unwrap(), "../escape").is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
