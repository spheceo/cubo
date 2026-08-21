//! Cubo CLI — `cubo serve`, `cubo search`, `cubo update`.
//!
//! Runs the exact same Core engine as the desktop app, headless. The web app
//! at the canonical deployment auto-detects it on localhost:8765.

mod paths;
mod search;
mod update;

use cubo_engine::logging;

use clap::{Parser, Subcommand};
use cubo_engine::engine;
use std::path::PathBuf;

/// Cubo's torrent engine, headless. Pair it with the web app at
/// app.cubo.spheceo.com and leave the machine alone.
#[derive(Parser)]
#[command(
    name = "cubo",
    version,
    about,
    after_help = "Run `cubo serve` to start streaming from this machine."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,

    /// Skip the "new version available" check.
    #[arg(long, global = true)]
    no_update_check: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Start the Cubo engine on this machine and open the web app.
    Serve {
        /// Do not open app.cubo.spheceo.com in a browser tab.
        #[arg(long)]
        no_open: bool,
    },
    /// Search titles in the media catalog (the same one the web app uses).
    Search {
        /// Title to look for, e.g. `cubo search "the avengers"`.
        query: Vec<String>,
    },
    /// Show a pairing code so another device can connect to this Cubo.
    Pair,
    /// Update the Cubo CLI to the latest release.
    Update,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    cubo_engine::raise_file_descriptor_limit();

    match &cli.command {
        Command::Serve { no_open } => {
            maybe_prompt_update(cli.no_update_check).await;
            serve(*no_open).await;
        }
        Command::Search { query } => {
            maybe_prompt_update(cli.no_update_check).await;
            search::run(&query.join(" ")).await;
        }
        Command::Pair => pair(),
        Command::Update => update::run().await,
    }
}

/// Prints the current pairing code. Codes are derived offline from a secret
/// in the Cubo data directory (authenticator-style), so this works whether
/// or not `cubo serve` is running — both read the same secret file.
fn pair() {
    if !cubo_engine::pairing::PAIRING_ENABLED {
        println!("Device pairing is not enabled in this version of Cubo yet.");
        println!("Remote devices connect directly; nothing to pair.");
        return;
    }
    match cubo_engine::pairing::current_code_for_dir(&paths::data_dir()) {
        Ok((code, remaining)) => {
            println!();
            println!("  Pairing code:  {code}");
            println!();
            println!("  On your other device, open https://app.cubo.spheceo.com,");
            println!("  point it at this machine, and enter the code when asked.");
            println!("  It stays valid for about {remaining} more seconds — run");
            println!("  `cubo pair` again any time for a fresh one. Each code you");
            println!("  redeem pairs one more device; they all keep working.");
            println!();
        }
        Err(error) => {
            eprintln!("Could not prepare a pairing code: {error}");
            std::process::exit(1);
        }
    }
}

async fn maybe_prompt_update(skip: bool) {
    if skip {
        return;
    }
    if let Some(latest) = update::check_for_latest_cached().await {
        println!(
            "A new Cubo version is available: {} (you have {})",
            latest.tag,
            env!("CARGO_PKG_VERSION")
        );
        print!("Update now? [y/N] ");
        use std::io::Write as _;
        let _ = std::io::stdout().flush();
        let mut answer = String::new();
        if std::io::stdin().read_line(&mut answer).is_ok()
            && matches!(answer.trim(), "y" | "Y" | "yes" | "Yes")
            && update::perform(&latest.asset_name).await
        {
            println!("Updated. Starting with your command anyway — the new binary is used next run.");
        }
    }
}

async fn serve(no_open: bool) {
    let data_dir = paths::data_dir();
    let downloads_dir = data_dir.join("downloads");
    if let Err(error) = std::fs::create_dir_all(&downloads_dir) {
        eprintln!(
            "Cubo could not create its data directory {}: {error}",
            data_dir.display()
        );
        std::process::exit(1);
    }

    logging::init(&data_dir);

    let port = match engine::start(downloads_dir.clone()).await {
        Ok(port) => port,
        Err(error) => {
            // Common cause worth explaining plainly: another Cubo already runs.
            eprintln!("Cubo failed to start: {error}");
            eprintln!(
                "If another copy of Cubo (desktop or CLI) is already running, stop it first — \
                 only one engine can own port {port_hint}.",
                port_hint = 8765
            );
            std::process::exit(1);
        }
    };

    tracing::info!("Cubo engine started on port {port}");
    println!();
    println!("  Cubo is running.");
    println!();
    println!("  Web app      https://app.cubo.spheceo.com  (opens automatically)");
    println!("                It finds this machine on its own; nothing to configure.");
    println!("  Engine       http://localhost:{port}  (local only)");
    if cubo_engine::pairing::PAIRING_ENABLED {
        println!("  Pairing      run `cubo pair` in another terminal to get a code");
        println!("                that connects your other devices to this Cubo.");
    }
    let downloads = engine::cache_directory()
        .await
        .unwrap_or(downloads_dir);
    println!("  Downloads    {}", downloads.display());
    println!("  Logs         {}", logging::log_path(&data_dir).display());
    println!();
    println!("  Keep this terminal window open while you stream.");
    println!("  Stop Cubo here any time with Ctrl+C.");
    println!();

    if !no_open {
        open_browser("https://app.cubo.spheceo.com");
    }

    tokio::signal::ctrl_c()
        .await
        .expect("install ctrl-c handler");
    tracing::info!("Cubo stopping (interrupt received)");
    println!("\nCubo stopped.");
}

fn open_browser(url: &str) {
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", url])
            .spawn()
    } else {
        std::process::Command::new("xdg-open").arg(url).spawn()
    };
    if let Err(error) = result {
        tracing::warn!("could not open browser automatically: {error}");
        println!("Open {} in your browser to start watching.", url);
    }
}

pub fn data_dir_display() -> PathBuf {
    paths::data_dir()
}
