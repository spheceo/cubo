//! `cubo persist` / `cubo unpersist` — keep the engine running like a
//! background service (LaunchAgent on macOS, systemd --user on Linux).
//!
//! The service runs `cubo serve --no-open --no-update-check` so login and
//! crash-restarts never pop a browser tab or hang on the update prompt.

use std::path::{Path, PathBuf};

const LABEL: &str = "com.spheceo.cubo";
const ENGINE_PORT: u16 = 8765;

pub fn install() {
    match install_inner() {
        Ok(()) => {}
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

pub fn uninstall() {
    match uninstall_inner() {
        Ok(()) => {}
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

/// After `cubo update` replaces the binary, bounce the service so the new
/// image is what KeepAlive / systemd actually execs.
pub fn restart_if_installed() {
    if !service_file().is_file() {
        return;
    }
    if let Err(error) = restart_service() {
        eprintln!("Cubo updated, but the background service did not restart: {error}");
        eprintln!("Run `cubo persist` again to reload it.");
    }
}

fn install_inner() -> Result<(), String> {
    let exe = current_binary()?;
    let home = home_dir()?;
    let log_dir = cubo_engine::paths::data_dir().join("logs");
    std::fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Could not create {}: {error}", log_dir.display()))?;

    let unit = service_file();
    if let Some(parent) = unit.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    std::fs::write(&unit, service_contents(&exe, &home, &log_dir)?)
        .map_err(|error| format!("Could not write {}: {error}", unit.display()))?;

    load_service()?;

    println!();
    println!("  Cubo will keep running in the background.");
    println!();
    println!("  Starts on login, and restarts on its own if it exits.");
    println!("  Web app      https://app.cubo.spheceo.com");
    println!("  Engine       http://localhost:{ENGINE_PORT}  (local only)");
    println!("  Logs         {}", log_dir.join("boot-service.log").display());
    println!("  Stop later   cubo unpersist");
    println!();
    if port_in_use() {
        println!("  Something is already listening on port {ENGINE_PORT}.");
        println!("  If that is a foreground `cubo serve` or the desktop app,");
        println!("  stop it — the background service takes the port after that.");
        println!();
    }
    Ok(())
}

fn uninstall_inner() -> Result<(), String> {
    let unit = service_file();
    unload_service().ok();
    if unit.is_file() {
        std::fs::remove_file(&unit)
            .map_err(|error| format!("Could not remove {}: {error}", unit.display()))?;
    }
    println!("Cubo will no longer start in the background.");
    Ok(())
}

fn current_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|error| format!("Could not locate the running Cubo binary: {error}"))?;
    Ok(exe.canonicalize().unwrap_or(exe))
}

fn home_dir() -> Result<PathBuf, String> {
    cubo_engine::paths::home_dir().ok_or_else(|| {
        "Cubo could not find your home directory (HOME is unset).".to_string()
    })
}

fn service_file() -> PathBuf {
    if cfg!(target_os = "macos") {
        launch_agents_dir().join(format!("{LABEL}.plist"))
    } else {
        systemd_user_dir().join("cubo.service")
    }
}

fn launch_agents_dir() -> PathBuf {
    cubo_engine::paths::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library")
        .join("LaunchAgents")
}

fn systemd_user_dir() -> PathBuf {
    cubo_engine::paths::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("systemd")
        .join("user")
}

fn service_contents(exe: &Path, home: &Path, log_dir: &Path) -> Result<String, String> {
    if cfg!(target_os = "macos") {
        Ok(macos_plist(exe, home, log_dir))
    } else if cfg!(target_os = "linux") {
        Ok(linux_unit(exe, home))
    } else {
        Err("Background persist is not supported on this platform yet. Run `cubo serve` instead.".into())
    }
}

fn macos_plist(exe: &Path, home: &Path, log_dir: &Path) -> String {
    let path = xml_escape(&service_path(&home.to_string_lossy()));
    let exe = xml_escape(&exe.to_string_lossy());
    let home = xml_escape(&home.to_string_lossy());
    let log = xml_escape(&log_dir.join("boot-service.log").to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>{home}</string>
		<key>PATH</key>
		<string>{path}</string>
	</dict>
	<key>KeepAlive</key>
	<true/>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{exe}</string>
		<string>serve</string>
		<string>--no-open</string>
		<string>--no-update-check</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>{log}</string>
	<key>StandardOutPath</key>
	<string>{log}</string>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>WorkingDirectory</key>
	<string>{home}</string>
</dict>
</plist>
"#
    )
}

fn linux_unit(exe: &Path, home: &Path) -> String {
    let exe = exe.to_string_lossy();
    let home = home.to_string_lossy();
    let path = service_path(&home);
    format!(
        "[Unit]\n\
         Description=Cubo streaming engine\n\
         After=network-online.target\n\
         \n\
         [Service]\n\
         ExecStart={exe} serve --no-open --no-update-check\n\
         Restart=always\n\
         RestartSec=5\n\
         Environment=HOME={home}\n\
         Environment=PATH={path}\n\
         WorkingDirectory={home}\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    )
}

fn service_path(home: &str) -> String {
    format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn load_service() -> Result<(), String> {
    if cfg!(target_os = "macos") {
        macos_reload()
    } else if cfg!(target_os = "linux") {
        linux_enable()
    } else {
        Err("Background persist is not supported on this platform yet.".into())
    }
}

fn unload_service() -> Result<(), String> {
    if cfg!(target_os = "macos") {
        macos_bootout()
    } else if cfg!(target_os = "linux") {
        run(
            "systemctl",
            &["--user", "disable", "--now", "cubo.service"],
        )
        .map(|_| ())
    } else {
        Ok(())
    }
}

fn restart_service() -> Result<(), String> {
    if cfg!(target_os = "macos") {
        macos_reload()
    } else if cfg!(target_os = "linux") {
        run("systemctl", &["--user", "daemon-reload"])?;
        run("systemctl", &["--user", "restart", "cubo.service"]).map(|_| ())
    } else {
        Ok(())
    }
}

fn macos_reload() -> Result<(), String> {
    let uid = user_id();
    let domain = format!("gui/{uid}");
    let service = format!("{domain}/{LABEL}");
    let plist = service_file();
    // bootout is fine when the service is not loaded yet.
    let _ = run("launchctl", &["bootout", &service]);
    run("launchctl", &["bootstrap", &domain, &plist.to_string_lossy()])?;
    let _ = run("launchctl", &["enable", &service]);
    run("launchctl", &["kickstart", "-k", &service]).map(|_| ())
}

fn macos_bootout() -> Result<(), String> {
    let uid = user_id();
    let service = format!("gui/{uid}/{LABEL}");
    match run("launchctl", &["bootout", &service]) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Already unloaded, or an older launchd — try the classic path.
            let _ = run(
                "launchctl",
                &["unload", "-w", &service_file().to_string_lossy()],
            );
            Ok(())
        }
    }
}

fn linux_enable() -> Result<(), String> {
    run("systemctl", &["--user", "daemon-reload"])?;
    run("systemctl", &["--user", "enable", "--now", "cubo.service"])?;
    // Linger keeps the user service up after logout on a headless box.
    let uid = user_id();
    let _ = run("loginctl", &["enable-linger", &uid]);
    Ok(())
}

fn user_id() -> String {
    #[cfg(unix)]
    {
        extern "C" {
            fn getuid() -> u32;
        }
        return unsafe { getuid() }.to_string();
    }
    #[cfg(not(unix))]
    {
        "1000".to_string()
    }
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("Could not run `{program}`: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|line| !line.is_empty())
        .unwrap_or("unknown error");
    Err(format!("`{program} {}` failed: {detail}", args.join(" ")))
}

fn port_in_use() -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], ENGINE_PORT)),
        std::time::Duration::from_millis(200),
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::{linux_unit, macos_plist, xml_escape, LABEL};
    use std::path::Path;

    #[test]
    fn plist_matches_the_t3_keepalive_shape() {
        let plist = macos_plist(
            Path::new("/Users/sphe/.local/bin/cubo"),
            Path::new("/Users/sphe"),
            Path::new("/Users/sphe/.local/share/cubo/logs"),
        );
        assert!(plist.contains(&format!("<string>{LABEL}</string>")));
        assert!(plist.contains("<key>KeepAlive</key>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<string>--no-open</string>"));
        assert!(plist.contains("<string>--no-update-check</string>"));
        assert!(plist.contains("/Users/sphe/.local/bin/cubo"));
        assert!(plist.contains("boot-service.log"));
    }

    #[test]
    fn unit_restarts_on_linux() {
        let unit = linux_unit(
            Path::new("/home/sphe/.local/bin/cubo"),
            Path::new("/home/sphe"),
        );
        assert!(unit.contains("Restart=always"));
        assert!(unit.contains("serve --no-open --no-update-check"));
        assert!(unit.contains("WantedBy=default.target"));
    }

    #[test]
    fn xml_escape_handles_ampersands() {
        assert_eq!(xml_escape("a&b<c>"), "a&amp;b&lt;c&gt;");
    }
}
