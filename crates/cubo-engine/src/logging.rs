//! Structured file + stderr logging for Cubo Core, shared by the desktop
//! shell and the headless CLI.
//!
//! Design notes:
//! - File writes go through `tracing_appender::non_blocking`, so log emission
//!   never blocks engine tasks — a slow disk cannot stall playback.
//! - The returned [`LoggingGuard`] must be kept alive for the process
//!   lifetime; dropping it detaches the writer thread and may drop tail lines.
//! - Verbosity defaults to `info`; `RUST_LOG=debug` (or `trace`) turns the
//!   dial up without a rebuild.

use std::path::Path;
use std::sync::OnceLock;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;

static GUARD: OnceLock<Option<WorkerGuard>> = OnceLock::new();

/// Where the current run's log file lives (for "where are my logs?" output).
pub fn log_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("logs").join("cubo.log")
}

/// Installs the global tracing subscriber exactly once. Later calls are
/// no-ops (the desktop shell and CLI both call this defensively). Returns
/// true when this call was the one that installed it.
pub fn init(data_dir: &Path) -> bool {
    let logs_dir = data_dir.join("logs");
    if std::fs::create_dir_all(&logs_dir).is_err() {
        return false;
    }

    let file_appender = tracing_appender::rolling::daily(&logs_dir, "cubo.log");
    let (writer, guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        // Terminal: compact, human-readable. The desktop webview never sees
        // stderr, so this only matters for CLI runs and `tauri dev`.
        .with(
            tracing_subscriber::fmt::layer()
                .with_target(false)
                .without_time()
                .with_writer(std::io::stderr),
        )
        // File: machine-greener, keeps targets and spans for forensics.
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer),
        );

    if tracing_subscriber::util::SubscriberInitExt::try_init(subscriber).is_err() {
        // Another path already installed a subscriber; nothing to do.
        return false;
    }

    let _ = GUARD.set(Some(guard));
    true
}
