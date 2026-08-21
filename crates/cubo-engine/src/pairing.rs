//! Offline device pairing, authenticator-style.
//!
//! Works exactly like a phone authenticator app: a random secret lives on
//! this machine (`pairing.key` in the Cubo data directory) and 6-digit codes
//! are derived from it plus the current time (HMAC-SHA256, 60-second steps,
//! RFC 4226 truncation). Anything that can read the secret file — the running
//! engine, or `cubo pair` in another terminal — computes the same codes with
//! no coordination, no network, and no external database.
//!
//! A remote device (e.g. another machine on the user's Tailscale network)
//! proves it is trusted by sending a current code to `POST /v1/pair`; in
//! exchange it receives a long-lived device token, persisted in
//! `paired-devices.json`, which authorizes it like the local session token.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// Master switch for the pairing flow. While false, Core behaves like before
/// pairing existed: /v1/health hands the session token to every caller and
/// /v1/pair answers 404. Flip to true to re-enable — the engine, CLI, and
/// web app all key off the server's behavior, so nothing else must change.
pub const PAIRING_ENABLED: bool = false;

/// Codes rotate once per minute. Verification accepts the previous and next
/// step too, so a code someone just read off a terminal stays valid while
/// they type it on the other device, and modest clock skew is tolerated.
const STEP_SECONDS: u64 = 60;
const CODE_DIGITS: u32 = 6;
/// Pairing attempts allowed per throttle window before the endpoint locks.
const MAX_FAILURES: usize = 5;
const THROTTLE_WINDOW_SECONDS: u64 = 60;

const SECRET_FILE: &str = "pairing.key";
const DEVICES_FILE: &str = "paired-devices.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub token: String,
    pub name: Option<String>,
    pub created_at: u64,
}

pub struct PairingManager {
    secret: [u8; 32],
    devices_path: PathBuf,
    devices: RwLock<Vec<PairedDevice>>,
    /// Fast lookup for request auth; mirrors `devices`.
    tokens: RwLock<HashSet<String>>,
    /// Unix seconds of recent failed attempts, for brute-force throttling.
    failures: RwLock<Vec<u64>>,
}

pub enum PairAttempt {
    /// Code accepted; the new device token to hand back.
    Accepted(String),
    Rejected,
    /// Too many recent failures; try again shortly.
    Throttled,
}

impl PairingManager {
    /// Loads (or creates) the pairing secret and known devices from `dir`.
    pub fn load(dir: &Path) -> Result<Self, String> {
        let secret = load_or_create_secret(&dir.join(SECRET_FILE))?;
        let devices_path = dir.join(DEVICES_FILE);
        let devices = load_devices(&devices_path);
        let tokens = devices.iter().map(|device| device.token.clone()).collect();
        Ok(Self {
            secret,
            devices_path,
            devices: RwLock::new(devices),
            tokens: RwLock::new(tokens),
            failures: RwLock::new(Vec::new()),
        })
    }

    pub fn is_device_token(&self, token: &str) -> bool {
        self.tokens
            .read()
            .is_ok_and(|tokens| tokens.contains(token))
    }

    /// Verifies a pairing code and, on success, mints and persists a new
    /// device token. Failed attempts are throttled process-wide.
    pub fn attempt_pair(&self, code: &str, device_name: Option<String>) -> PairAttempt {
        let now = unix_seconds();
        if self.is_throttled(now) {
            return PairAttempt::Throttled;
        }
        if !verify_code(&self.secret, code, now) {
            if let Ok(mut failures) = self.failures.write() {
                failures.push(now);
            }
            return PairAttempt::Rejected;
        }

        let device = PairedDevice {
            token: uuid::Uuid::new_v4().simple().to_string(),
            name: device_name.filter(|name| !name.trim().is_empty()),
            created_at: now,
        };
        let token = device.token.clone();
        if let Ok(mut tokens) = self.tokens.write() {
            tokens.insert(token.clone());
        }
        if let Ok(mut devices) = self.devices.write() {
            devices.push(device);
            if let Err(error) = save_devices(&self.devices_path, &devices) {
                tracing::warn!(target: "engine", error = %error, "could not persist paired device");
            }
        }
        PairAttempt::Accepted(token)
    }

    fn is_throttled(&self, now: u64) -> bool {
        let Ok(mut failures) = self.failures.write() else {
            return true;
        };
        failures.retain(|at| now.saturating_sub(*at) < THROTTLE_WINDOW_SECONDS);
        failures.len() >= MAX_FAILURES
    }
}

/// The current pairing code plus how many seconds it remains the "current"
/// one. Used by `cubo serve` / `cubo pair` to show codes in the terminal.
pub fn current_code_for_dir(dir: &Path) -> Result<(String, u64), String> {
    let secret = load_or_create_secret(&dir.join(SECRET_FILE))?;
    let now = unix_seconds();
    let remaining = STEP_SECONDS - (now % STEP_SECONDS);
    Ok((code_at(&secret, now / STEP_SECONDS), remaining))
}

fn load_or_create_secret(path: &Path) -> Result<[u8; 32], String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let mut secret = [0u8; 32];
        if hex::decode_to_slice(existing.trim(), &mut secret).is_ok() {
            return Ok(secret);
        }
        // Unreadable secret: fall through and regenerate. Existing paired
        // devices keep working — their tokens are stored separately.
        tracing::warn!(target: "engine", "pairing secret was invalid; generating a new one");
    }

    let mut secret = [0u8; 32];
    getrandom::fill(&mut secret).map_err(|error| format!("no randomness source: {error}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create data directory: {error}"))?;
    }
    std::fs::write(path, hex::encode(secret))
        .map_err(|error| format!("could not write pairing secret: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(secret)
}

fn load_devices(path: &Path) -> Vec<PairedDevice> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_devices(path: &Path, devices: &[PairedDevice]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(devices).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn verify_code(secret: &[u8; 32], code: &str, now: u64) -> bool {
    let code = code.trim();
    if code.len() != CODE_DIGITS as usize || !code.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let step = now / STEP_SECONDS;
    // Previous, current, and next step: tolerate typing delay and clock skew.
    [step.saturating_sub(1), step, step + 1]
        .iter()
        .any(|candidate| code_at(secret, *candidate) == code)
}

/// RFC 4226 dynamic truncation over HMAC-SHA256 of the big-endian step.
fn code_at(secret: &[u8; 32], step: u64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(&step.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let value = u32::from_be_bytes([
        digest[offset] & 0x7f,
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]);
    format!("{:06}", value % 10u32.pow(CODE_DIGITS))
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_six_digits_and_rotate_per_step() {
        let secret = [7u8; 32];
        let a = code_at(&secret, 1);
        let b = code_at(&secret, 2);
        assert_eq!(a.len(), 6);
        assert!(a.bytes().all(|byte| byte.is_ascii_digit()));
        assert_ne!(a, b, "adjacent steps must produce different codes");
    }

    #[test]
    fn verification_accepts_adjacent_steps_only() {
        let secret = [9u8; 32];
        let now = 1_700_000_000u64;
        let step = now / STEP_SECONDS;
        assert!(verify_code(&secret, &code_at(&secret, step), now));
        assert!(verify_code(&secret, &code_at(&secret, step - 1), now));
        assert!(verify_code(&secret, &code_at(&secret, step + 1), now));
        assert!(!verify_code(&secret, &code_at(&secret, step + 2), now));
        assert!(!verify_code(&secret, "not-a-code", now));
        assert!(!verify_code(&secret, "12345", now));
    }

    #[test]
    fn pairing_manager_round_trip() {
        let dir = std::env::temp_dir().join(format!("cubo-pair-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create test dir");

        let manager = PairingManager::load(&dir).expect("load manager");
        let (code, _) = current_code_for_dir(&dir).expect("current code");

        let token = match manager.attempt_pair(&code, Some("test device".into())) {
            PairAttempt::Accepted(token) => token,
            _ => panic!("valid code must pair"),
        };
        assert!(manager.is_device_token(&token));
        assert!(!manager.is_device_token("unknown"));

        // A fresh manager (engine restart) still knows the device.
        let reloaded = PairingManager::load(&dir).expect("reload manager");
        assert!(reloaded.is_device_token(&token));

        // Wrong codes are rejected and eventually throttled.
        assert!(matches!(
            manager.attempt_pair("000000", None),
            PairAttempt::Rejected | PairAttempt::Accepted(_)
        ));
        for _ in 0..MAX_FAILURES {
            let _ = manager.attempt_pair("999999", None);
        }
        assert!(matches!(
            manager.attempt_pair(&code, None),
            PairAttempt::Throttled
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
