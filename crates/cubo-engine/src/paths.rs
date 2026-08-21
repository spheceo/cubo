//! Filesystem layout for Cubo data. Deliberately independent of the desktop
//! app's Tauri-managed directories so both can coexist.

use std::path::PathBuf;

/// The user's home directory, from HOME (unix) or USERPROFILE (Windows).
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Per-user data directory: `~/.local/share/cubo` on macOS/Linux,
/// `%LOCALAPPDATA%\cubo` on Windows.
pub fn data_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("USERPROFILE")
                    .map(|home| PathBuf::from(home).join("AppData").join("Local"))
                    .unwrap_or_else(|| PathBuf::from("."))
            });
        return base.join("cubo");
    }

    let home = std::env::var_os("HOME").unwrap_or_default();
    if home.is_empty() {
        return PathBuf::from(".");
    }
    PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("cubo")
}
