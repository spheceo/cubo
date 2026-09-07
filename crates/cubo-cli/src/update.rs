//! `cubo update` and the y/n upgrade prompt shared by every command.

pub use cubo_engine::update::{check_for_latest_cached, perform};

pub async fn run() {
    match cubo_engine::update::check_for_latest().await {
        Ok(None) => {
            println!(
                "Cubo is up to date ({}).",
                env!("CARGO_PKG_VERSION")
            );
        }
        Ok(Some(release)) => {
            println!("Updating Cubo to {}...", release.tag);
            if perform(&release.tag, &release.asset_url).await {
                crate::persist::restart_if_installed();
                println!("Done. Restart Cubo when you like.");
            }
        }
        Err(error) => eprintln!("Could not check for updates: {error}"),
    }
}
