use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body, Bytes};
use axum::extract::ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequestParts, Path, Query, State};
use axum::http::header::{
    ACCEPT_RANGES, AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use librqbit::http_api::{HttpApi, HttpApiOptions};
use librqbit::{Api, Session};
use librqbit_dualstack_sockets::TcpListener as RqbitListener;
use serde::Deserialize;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, OnceCell, RwLock};
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::cache;
use crate::pairing::{PairAttempt, PairingManager};
use crate::paths::home_dir;
use crate::store::{self, CoreStore, PlaybackUpdate, WatchLaterUpdate};
use crate::system;
use crate::transcode::TranscodeManager;
use crate::update::UpdateManager;

const CORE_PORT: u16 = 8765;
/// How many ports after `CORE_PORT` to try when the preferred one is taken
/// (e.g. `cubo persist` already owns :8765 and `just dev` should not kill it).
const CORE_PORT_SCAN: u16 = 20;
const WEB_PROXY_BODY_LIMIT: usize = 10 * 1024 * 1024;
/// Catalog pages and static assets. Fail before the old 45 s hang when the
/// Vite origin is unreachable. `/api/*` is handled by Core itself.
const WEB_PROXY_TIMEOUT: Duration = Duration::from_secs(8);
// The Vite dev server uses the loopback pair.
const DEFAULT_ALLOWED_ORIGINS: [&str; 2] = [
    "http://localhost:4200",
    "http://127.0.0.1:4200",
];
/// Ports a loopback or own-hostname origin may always use, plus the port
/// this process actually bound (see `OriginPolicy::allowed_ports`).
const BASE_ALLOWED_ORIGIN_PORTS: [u16; 2] = [CORE_PORT, 4200];

pub struct Engine {
    bridge_port: u16,
    bridge_addresses: Vec<SocketAddr>,
    download_dir: Arc<RwLock<PathBuf>>,
    // Held for the app's lifetime so the session and its DHT tasks stay alive.
    _session: Arc<Session>,
}

#[derive(Clone)]
struct BridgeState {
    rqbit_port: u16,
    token: Arc<str>,
    client: reqwest::Client,
    web_origin: Option<Arc<str>>,
    /// Hostnames/IPs this machine answers to (hostname, Tailscale IP). Pages
    /// served from e.g. http://kenobi:4200 on another tailnet device carry
    /// that origin, so the CORS layer accepts host matches — but only on
    /// Cubo's own ports (see `allowed_origin_ports`).
    allowed_hosts: Arc<Vec<String>>,
    bridge_port: u16,
    download_dir: Arc<RwLock<PathBuf>>,
    /// Last time a viewer was clearly pulling video (progress, buffer poll,
    /// remux segment). Playlist polls do not count — those continue while paused.
    playback_last_ms: Arc<AtomicU64>,
    cache_swap: Arc<Mutex<()>>,
    /// True while the cache volume has no more than 10 GB free. The web UI
    /// reads this from /v1/cache and shows a banner; maintenance pauses
    /// background torrents for as long as it stays set.
    disk_pressure: Arc<AtomicBool>,
    store: CoreStore,
    transcode: Arc<TranscodeManager>,
    /// Computed OpenSubtitles release matches, keyed by `{torrent}:{file}`.
    /// Each one costs two ranged reads through rqbit (the tail can pull
    /// pieces from peers), so results are remembered for the session.
    subtitle_matches: Arc<Mutex<HashMap<String, SubtitleMatchInfo>>>,
    /// Authenticator-style pairing: verifies offline codes and remembers
    /// device tokens issued to remote (non-loopback) clients.
    pairing: Arc<PairingManager>,
    updater: Arc<UpdateManager>,
}

impl BridgeState {
    async fn current_download_dir(&self) -> PathBuf {
        self.download_dir.read().await.clone()
    }

    fn mark_playback(&self) {
        self.playback_last_ms
            .store(store::now_millis(), Ordering::Release);
    }

    fn is_playback_active(&self) -> bool {
        let last = self.playback_last_ms.load(Ordering::Acquire);
        last != 0 && store::now_millis().saturating_sub(last) < PLAYBACK_GUARD_MS
    }
}

#[derive(Deserialize)]
struct StreamQuery {
    token: String,
}
#[derive(Deserialize)]
struct HlsQuery {
    token: String,
    /// Seconds into the source the remux should begin at. Seeking into an
    /// unconverted region restarts ffmpeg here instead of waiting for it.
    start: Option<f64>,
    /// Monotonic seek id from the player. Leftover hls.js polls of a
    /// previous playlist URL carry an older value and must not restart
    /// ffmpeg at that stale offset.
    gen: Option<u64>,
}

/// Progress ticks every 10s while playing; this window covers a missed tick
/// plus the pause report so a swap is refused until the viewer actually stops.
const PLAYBACK_GUARD_MS: u64 = 20_000;
/// Keep a just-added title on disk (and unpaused) through metadata, remux
/// probe, and the first segments. The 20 s playback guard expires in the
/// middle of ffprobe; 3 minutes was still shorter than a cold seek-remux.
const CACHE_STARTUP_GRACE_MS: u64 = 600_000;

static ENGINE: OnceCell<Engine> = OnceCell::const_new();

/// Starts rqbit on a private ephemeral port and Cubo Core on the permanent
/// loopback and detected Tailscale addresses. Repeated calls reuse the engine.
pub async fn start(download_dir: PathBuf) -> Result<u16, String> {
    let engine = ENGINE
        .get_or_try_init(|| async {
            let state_path = download_dir
                .parent()
                .unwrap_or(download_dir.as_path())
                .join("cubo-state.json");
            let store = CoreStore::load(state_path.clone()).await?;
            // Pairing state lives in the SHARED Cubo data dir, not next to
            // this process's store: `cubo pair` (a separate process) reads
            // paths::data_dir() — both must see one secret, or codes printed
            // in the terminal would never match a running Core.
            let pairing = Arc::new(PairingManager::load(&crate::paths::data_dir())?);
            let download_dir = resolve_startup_download_dir(&store, download_dir).await;
            let session = Session::new(download_dir.clone())
                .await
                .map_err(|e| format!("rqbit session init failed: {e:#}"))?;

            let api = Api::new(session.clone(), None, None);
            let http_api = HttpApi::new(
                api,
                Some(HttpApiOptions {
                    read_only: false,
                    allow_create: true,
                    ..Default::default()
                }),
            );

            let rqbit_listener = RqbitListener::bind_tcp(
                SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                Default::default(),
            )
            .map_err(|e| format!("failed to bind rqbit server: {e:#}"))?;
            let rqbit_port = rqbit_listener.bind_addr().port();

            tokio::spawn(async move {
                if let Err(error) = http_api.make_http_api_and_run(rqbit_listener, None).await {
                    tracing::error!(target: "engine", error = %error, "rqbit HTTP API exited");
                }
            });

            // Probed once here; binding and the CORS host allowlist both use it.
            let tailscale_address = detect_tailscale_ipv4();
            let (bridge_port, bridge_listeners) = bind_bridges(tailscale_address).await?;
            let bridge_addresses = bridge_listeners
                .iter()
                .filter_map(|listener| listener.local_addr().ok())
                .collect::<Vec<_>>();
            // Remux output stays next to Cubo state, not inside the (movable)
            // torrent cache. A directory swap must not relocate ffmpeg jobs.
            let transcode_dir = state_path
                .parent()
                .unwrap_or(download_dir.as_path())
                .join("transcode");
            let download_dir = Arc::new(RwLock::new(download_dir));
            let state = BridgeState {
                rqbit_port,
                token: Uuid::new_v4().simple().to_string().into(),
                client: reqwest::Client::new(),
                web_origin: resolve_web_origin()?,
                allowed_hosts: Arc::new(local_machine_hosts(tailscale_address)),
                bridge_port,
                download_dir: download_dir.clone(),
                playback_last_ms: Arc::new(AtomicU64::new(0)),
                cache_swap: Arc::new(Mutex::new(())),
                disk_pressure: Arc::new(AtomicBool::new(false)),
                store,
                transcode: Arc::new(TranscodeManager::new(transcode_dir)),
                subtitle_matches: Arc::new(Mutex::new(HashMap::new())),
                pairing,
                updater: Arc::new(UpdateManager::new()),
            };
            let router = bridge_router(state.clone());

            let maintenance_state = state.clone();
            tokio::spawn(async move {
                cache_maintenance_loop(maintenance_state).await;
            });

            tracing::info!(
                target: "engine",
                bridge_port,
                rqbit_port,
                addresses = ?bridge_addresses,
                "Cubo engine started"
            );

            for listener in bridge_listeners {
                let listener_router = router.clone();
                tokio::spawn(async move {
                    // Connect info lets /v1/health tell loopback callers
                    // (handed the session token) from remote ones (must pair).
                    let service =
                        listener_router.into_make_service_with_connect_info::<SocketAddr>();
                    if let Err(error) = axum::serve(listener, service).await {
                        tracing::error!(target: "engine", error = %error, "Cubo bridge exited");
                    }
                });
            }

            Ok::<Engine, String>(Engine {
                bridge_port,
                bridge_addresses,
                download_dir,
                _session: session,
            })
        })
        .await?;

    Ok(engine.bridge_port)
}

pub async fn cache_directory() -> Option<PathBuf> {
    match ENGINE.get() {
        Some(engine) => Some(engine.download_dir.read().await.clone()),
        None => None,
    }
}

async fn resolve_startup_download_dir(store: &CoreStore, default_dir: PathBuf) -> PathBuf {
    let configured = store
        .snapshot()
        .await
        .cache
        .directory
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    let candidate = configured.unwrap_or(default_dir.clone());
    match tokio::fs::create_dir_all(&candidate).await {
        Ok(()) => candidate,
        Err(error) => {
            tracing::warn!(
                target: "engine",
                path = %candidate.display(),
                error = %error,
                "configured cache directory is not usable; falling back to default"
            );
            let _ = tokio::fs::create_dir_all(&default_dir).await;
            default_dir
        }
    }
}

#[allow(dead_code)]
pub fn status() -> serde_json::Value {
    match ENGINE.get() {
        Some(engine) => json!({
            "state": "running",
            "engine": "rqbit",
            "version": librqbit::version(),
            "port": engine.bridge_port,
            "addresses": engine.bridge_addresses,
        }),
        None => json!({
            "state": "idle",
            "engine": null,
        }),
    }
}

enum BindAttempt {
    Ready(Vec<TcpListener>),
    Busy,
    Failed(String),
}

async fn bind_bridges(
    tailscale_address: Option<IpAddr>,
) -> Result<(u16, Vec<TcpListener>), String> {
    let mut addresses = vec![
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ];
    if let Some(address) = tailscale_address {
        if !address.is_loopback() && !addresses.contains(&address) {
            addresses.push(address);
        }
    }

    let last = CORE_PORT.saturating_add(CORE_PORT_SCAN - 1);
    for port in CORE_PORT..=last {
        match try_bind_port(&addresses, port).await {
            BindAttempt::Ready(listeners) => {
                if port != CORE_PORT {
                    tracing::info!(
                        target: "engine",
                        preferred = CORE_PORT,
                        port,
                        "preferred port in use; bound the next free port"
                    );
                }
                return Ok((port, listeners));
            }
            BindAttempt::Busy => continue,
            BindAttempt::Failed(error) => return Err(error),
        }
    }

    Err(format!(
        "Cubo Core could not bind {CORE_PORT}-{last}: every port is in use"
    ))
}

async fn try_bind_port(addresses: &[IpAddr], port: u16) -> BindAttempt {
    let mut listeners = Vec::new();
    for address in addresses {
        match TcpListener::bind((*address, port)).await {
            Ok(listener) => listeners.push(listener),
            Err(error) if *address == IpAddr::V4(Ipv4Addr::LOCALHOST) => {
                return if error.kind() == std::io::ErrorKind::AddrInUse {
                    BindAttempt::Busy
                } else {
                    BindAttempt::Failed(format!(
                        "Cubo Core could not bind {address}:{port}: {error}"
                    ))
                };
            }
            Err(error) => {
                tracing::warn!(
                    target: "engine",
                    %address, port, %error,
                    "Cubo Core could not bind optional address"
                );
            }
        }
    }
    if listeners.is_empty() {
        BindAttempt::Failed(format!("Cubo Core could not bind any address on port {port}"))
    } else {
        BindAttempt::Ready(listeners)
    }
}

fn detect_tailscale_ipv4() -> Option<IpAddr> {
    let candidates = [
        "tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ];

    for executable in candidates {
        let Ok(output) = Command::new(executable).args(["ip", "-4"]).output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        if let Some(address) = String::from_utf8_lossy(&output.stdout)
            .lines()
            .find_map(|line| line.trim().parse::<IpAddr>().ok())
        {
            return Some(address);
        }
    }

    None
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// Lowercased host and effective port of an Origin header.
fn origin_host_port(origin: &HeaderValue) -> Option<(String, Option<u16>)> {
    let origin = origin.to_str().ok()?;
    let url = reqwest::Url::parse(origin).ok()?;
    let host = url
        .host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())?;
    Some((host, url.port_or_known_default()))
}

/// Which browser origins may call the /v1 API. Exact allowlisted origins
/// (dev servers and the web deployment) pass as-is; loopback
/// and own-hostname/Tailscale origins pass only on Cubo's own ports, so an
/// unrelated local app on some other port is not silently trusted.
struct OriginPolicy {
    allowed_origins: Arc<Vec<HeaderValue>>,
    allowed_hosts: Arc<Vec<String>>,
    allowed_ports: Arc<Vec<u16>>,
}

impl OriginPolicy {
    fn allows(&self, origin: &HeaderValue) -> bool {
        if self.allowed_origins.iter().any(|allowed| allowed == origin) {
            return true;
        }
        let Some((host, port)) = origin_host_port(origin) else {
            return false;
        };
        if !port.is_some_and(|port| self.allowed_ports.contains(&port)) {
            return false;
        }
        is_loopback_host(&host) || self.allowed_hosts.contains(&host)
    }
}

fn allowed_origin_ports(bridge_port: u16) -> Arc<Vec<u16>> {
    let mut ports = BASE_ALLOWED_ORIGIN_PORTS.to_vec();
    if !ports.contains(&bridge_port) {
        ports.push(bridge_port);
    }
    Arc::new(ports)
}

/// Hostnames and addresses pages can use to reach this machine over the
/// network: the system hostname and the detected Tailscale IPv4.
fn local_machine_hosts(tailscale_address: Option<IpAddr>) -> Vec<String> {
    let mut hosts = Vec::new();
    for executable in ["hostname", "/bin/hostname"] {
        if let Ok(output) = Command::new(executable).output() {
            if output.status.success() {
                let name = String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .to_ascii_lowercase();
                if !name.is_empty() {
                    hosts.push(name.clone());
                    // macOS reports "<name>.local"; peers reach the machine by
                    // the bare name (MagicDNS/LAN), so allow both forms.
                    if let Some(bare) = name.strip_suffix(".local") {
                        hosts.push(bare.to_string());
                    }
                    break;
                }
            }
        }
    }
    if let Some(address) = tailscale_address {
        hosts.push(address.to_string());
    }
    hosts
}

fn bridge_router(state: BridgeState) -> Router {
    let policy = Arc::new(OriginPolicy {
        allowed_origins: allowed_origins(state.web_origin.as_deref()),
        allowed_hosts: state.allowed_hosts.clone(),
        allowed_ports: allowed_origin_ports(state.bridge_port),
    });
    let cors_policy = policy.clone();
    let allow_origin =
        AllowOrigin::predicate(move |origin: &HeaderValue, _| cors_policy.allows(origin));
    let cors = CorsLayer::new()
        .allow_origin(allow_origin)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            AUTHORIZATION,
            CONTENT_TYPE,
            RANGE,
            HeaderName::from_static("x-cubo-media-key"),
            HeaderName::from_static("x-cubo-title"),
            HeaderName::from_static("x-cubo-file-index"),
        ])
        .expose_headers([
            ACCEPT_RANGES,
            CONTENT_LENGTH,
            CONTENT_RANGE,
            CONTENT_TYPE,
            HeaderName::from_static("x-cubo-duration"),
            HeaderName::from_static("x-cubo-start"),
        ]);

    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/pair", post(pair_device))
        .route("/v1/system", get(system_stats))
        .route("/v1/folders", get(list_folders).post(create_folder))
        .route("/v1/torrents", post(add_torrent))
        .route("/v1/torrents/{id}/stats", get(torrent_stats))
        .route("/v1/torrents/{id}/stream/{file_index}", get(stream_torrent))
        .route(
            "/v1/torrents/{id}/files/{file_index}/subtitle-match",
            get(torrent_subtitle_match),
        )
        .route("/v1/torrents/{id}/hls/{file_index}/{file}", get(hls_file))
        .route("/v1/library", get(library_snapshot))
        .route("/v1/library/progress", post(record_playback))
        .route("/v1/library/watch-later", post(update_watch_later))
        .route(
            "/v1/library/history/{key}",
            axum::routing::delete(remove_history_item),
        )
        .route("/v1/cache", get(cache_status).delete(clear_cache))
        .route("/v1/cache/settings", put(update_cache_settings))
        .route("/v1/cache/directory", put(update_cache_directory))
        .route("/v1/cache/{id}", axum::routing::delete(delete_cache_item))
        .route("/v1/client-log", post(client_log))
        .route("/v1/update", get(update_status).post(download_update))
        .route("/v1/update/apply", post(apply_update))
        .fallback(web_fallback)
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn(move |request, next| {
            let policy = policy.clone();
            add_private_network_header(policy, request, next)
        }))
}

fn allowed_origins(web_origin: Option<&str>) -> Arc<Vec<HeaderValue>> {
    let origins = DEFAULT_ALLOWED_ORIGINS
        .into_iter()
        .chain(web_origin)
        .filter_map(|value| HeaderValue::from_str(value).ok())
        .collect();
    Arc::new(origins)
}

/// Debug builds proxy the local Vite server. Release builds serve the
/// embedded Vite `dist` and leave this unset.
fn resolve_web_origin() -> Result<Option<Arc<str>>, String> {
    if cfg!(debug_assertions) {
        Ok(Some("http://127.0.0.1:4200".into()))
    } else {
        Ok(None)
    }
}

/// Browsers gate public-site requests to local servers behind a preflight
/// asking for private-network access. Grant it only to origins that already
/// pass the CORS policy — answering "yes" unconditionally would erode the
/// exact protection the browser is trying to provide.
async fn add_private_network_header(
    policy: Arc<OriginPolicy>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let wants_private_network = request
        .headers()
        .get("access-control-request-private-network")
        .is_some_and(|value| value == "true");
    let origin_allowed = request
        .headers()
        .get(axum::http::header::ORIGIN)
        .is_some_and(|origin| policy.allows(origin));
    let mut response = next.run(request).await;
    if wants_private_network && origin_allowed {
        response.headers_mut().insert(
            HeaderName::from_static("access-control-allow-private-network"),
            HeaderValue::from_static("true"),
        );
    }
    response
}

/// Ingests a diagnostic event emitted by the web app (stream selection,
/// fallback switches, playback errors) into the same structured log the
/// engine writes to, so one file tells the whole story of a session.
async fn client_log(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(payload): Json<ClientLogPayload>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }

    let data = payload
        .data
        .as_ref()
        .map(serde_json::Value::to_string)
        .unwrap_or_default();

    match payload.level.as_str() {
        "error" => tracing::error!(
            target: "client",
            event = %payload.event,
            data = %data,
            "web app report",
        ),
        "warn" => tracing::warn!(
            target: "client",
            event = %payload.event,
            data = %data,
            "web app report",
        ),
        _ => tracing::info!(
            target: "client",
            event = %payload.event,
            data = %data,
            "web app report",
        ),
    }

    StatusCode::OK.into_response()
}

async fn update_status(State(state): State<BridgeState>, headers: HeaderMap) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    Json(state.updater.status().await).into_response()
}

async fn download_update(State(state): State<BridgeState>, headers: HeaderMap) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    match state.updater.download().await {
        Ok(status) => Json(status).into_response(),
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn apply_update(State(state): State<BridgeState>, headers: HeaderMap) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    match state.updater.apply().await {
        Ok(status) => Json(status).into_response(),
        Err(error) => bridge_error(StatusCode::CONFLICT, error),
    }
}

#[derive(Deserialize)]
struct ClientLogPayload {
    level: String,
    event: String,
    #[serde(default)]
    data: Option<serde_json::Value>,
}

/// Discovery endpoint. With pairing enabled, the session token — full
/// control of this Core — is only handed to callers on this same machine
/// (loopback); a remote device (another tailnet machine) gets
/// `pairingRequired` instead and must present a pairing code at /v1/pair to
/// receive its own token. While PAIRING_ENABLED is false, every caller gets
/// the token (pre-pairing behavior).
async fn health(
    State(state): State<BridgeState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    let is_local_caller = !crate::pairing::PAIRING_ENABLED || peer.ip().is_loopback();
    let mut body = json!({
        "name": "cubo-core",
        "version": env!("CARGO_PKG_VERSION"),
        "engine": "rqbit",
        "engineVersion": librqbit::version(),
        "webUrl": state.web_origin,
        "transcode": state.transcode.available(),
        "pairingRequired": !is_local_caller,
    });
    if is_local_caller {
        body["sessionToken"] = json!(state.token.as_ref());
    }
    Json(body)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairBody {
    code: String,
    #[serde(default)]
    device_name: Option<String>,
}

/// Exchanges a current pairing code (shown by `cubo pair` on the machine
/// running Core) for a long-lived device token.
async fn pair_device(State(state): State<BridgeState>, Json(body): Json<PairBody>) -> Response {
    if !crate::pairing::PAIRING_ENABLED {
        return bridge_error(
            StatusCode::NOT_FOUND,
            "Pairing is not enabled on this Core.".into(),
        );
    }
    let pairing = state.pairing.clone();
    let attempt =
        tokio::task::spawn_blocking(move || pairing.attempt_pair(&body.code, body.device_name))
            .await;
    match attempt {
        Ok(PairAttempt::Accepted(token)) => Json(json!({ "token": token })).into_response(),
        Ok(PairAttempt::Rejected) => bridge_error(
            StatusCode::UNAUTHORIZED,
            "That code is not right or has expired. Run `cubo pair` on the machine running Cubo for a fresh one.".into(),
        ),
        Ok(PairAttempt::Throttled) => bridge_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many attempts. Wait a minute, then try a fresh code.".into(),
        ),
        Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn system_stats(State(state): State<BridgeState>, headers: HeaderMap) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    // Sampling CPU takes ~250ms; keep it off the async runtime.
    let download_dir = state.current_download_dir().await;
    let snapshot = tokio::task::spawn_blocking(move || system::snapshot(&download_dir)).await;
    match snapshot {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[derive(Deserialize)]
struct FoldersQuery {
    path: Option<String>,
}

async fn list_folders(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Query(query): Query<FoldersQuery>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    let path = query.path;
    match tokio::task::spawn_blocking(move || system::list_folders(path.as_deref())).await {
        Ok(Ok(listing)) => Json(listing).into_response(),
        Ok(Err(error)) => bridge_error(StatusCode::BAD_REQUEST, error),
        Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[derive(Deserialize)]
struct CreateFolderBody {
    parent: String,
    name: String,
}

async fn create_folder(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(body): Json<CreateFolderBody>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    match tokio::task::spawn_blocking(move || system::create_folder(&body.parent, &body.name)).await
    {
        Ok(Ok(folder)) => Json(folder).into_response(),
        Ok(Err(error)) => bridge_error(StatusCode::BAD_REQUEST, error),
        Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheSettingsUpdate {
    max_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheDirectoryUpdate {
    directory: String,
}

#[derive(Deserialize)]
struct TorrentListResponse {
    #[serde(default)]
    torrents: Vec<TorrentListItem>,
}

#[derive(Deserialize)]
struct TorrentListItem {
    id: Option<u64>,
    info_hash: String,
}

async fn library_snapshot(State(state): State<BridgeState>, headers: HeaderMap) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    Json(state.store.snapshot().await).into_response()
}

async fn record_playback(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(update): Json<PlaybackUpdate>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    if update.session_started || update.watched_delta_seconds > 0.0 {
        state.mark_playback();
    }
    // Ticks arrive every ~10 s; echoing the whole library back each time
    // serialized hundreds of items for a response nobody reads.
    match state.store.record_playback(update).await {
        Ok(()) => {
            let maintenance = state.clone();
            tokio::spawn(async move {
                if let Err(error) = apply_download_window(&maintenance).await {
                    tracing::warn!(target: "engine", error = %error, "download window failed");
                }
            });
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn update_watch_later(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(update): Json<WatchLaterUpdate>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    match state.store.update_watch_later(update).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn remove_history_item(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    match state.store.remove_history_item(&key).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn update_cache_settings(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(update): Json<CacheSettingsUpdate>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    match state.store.update_cache_limit(update.max_bytes).await {
        Ok(snapshot) => {
            let maintenance = state.clone();
            tokio::spawn(async move {
                if let Err(error) = enforce_cache_limit(&maintenance).await {
                    tracing::warn!(target: "engine", error = %error, "cache maintenance failed");
                }
            });
            Json(snapshot.cache).into_response()
        }
        Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn update_cache_directory(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(update): Json<CacheDirectoryUpdate>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }

    let _swap = state.cache_swap.lock().await;
    if state.is_playback_active() {
        return bridge_error(
            StatusCode::CONFLICT,
            "Pause playback before changing the cache folder.".into(),
        );
    }

    let old_dir = state.current_download_dir().await;
    let new_dir = match prepare_cache_directory(&update.directory, state.store.path(), &old_dir) {
        Ok(path) => path,
        Err(error) => return bridge_error(StatusCode::BAD_REQUEST, error),
    };
    if paths_match(&old_dir, &new_dir) {
        let snapshot = state.store.snapshot().await;
        return Json(json!({
            "maxBytes": snapshot.cache.max_bytes,
            "directory": old_dir.to_string_lossy(),
        }))
        .into_response();
    }

    match system::folder_contains_files(&new_dir) {
        Ok(true) => {
            return bridge_error(
                StatusCode::BAD_REQUEST,
                "That folder already has files. Pick an empty folder.".into(),
            );
        }
        Ok(false) => {}
        Err(error) => return bridge_error(StatusCode::BAD_REQUEST, error),
    }

    if let Err(error) = empty_cache(&state, &old_dir).await {
        return bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error);
    }

    match state.store.update_cache_directory(new_dir.clone()).await {
        Ok(snapshot) => {
            *state.download_dir.write().await = new_dir.clone();
            tracing::info!(
                target: "engine",
                from = %old_dir.display(),
                to = %new_dir.display(),
                "cache directory changed"
            );
            Json(json!({
                "maxBytes": snapshot.cache.max_bytes,
                "directory": new_dir.to_string_lossy(),
            }))
            .into_response()
        }
        Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn cache_status(State(state): State<BridgeState>, headers: HeaderMap) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    let snapshot = state.store.snapshot().await;
    let download_dir = state.current_download_dir().await;
    let transcode_dir = state.transcode.dir().to_path_buf();
    let free_bytes = system::volume_free_bytes(&download_dir);
    let tight = cache::disk_is_tight(free_bytes);
    state.disk_pressure.store(tight, Ordering::Release);
    match cache_size(download_dir.clone(), transcode_dir).await {
        Ok(used_bytes) => Json(json!({
            "usedBytes": used_bytes,
            "maxBytes": snapshot.cache.max_bytes,
            "directory": download_dir.to_string_lossy(),
            "itemCount": snapshot.cache_entries.len(),
            "entries": snapshot.cache_entries,
            "diskFreeBytes": free_bytes,
            "diskReserveBytes": cache::DISK_RESERVE_BYTES,
            "diskPressure": tight,
        }))
        .into_response(),
        Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn delete_cache_item(
    State(state): State<BridgeState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }

    // rqbit forgets its torrents when the app restarts, so it deleting the
    // torrent is the happy path, not the source of truth. "Unknown torrent"
    // is fine — the recorded file paths get removed from disk either way.
    if let Err(error) = rqbit_delete(&state, &id).await {
        return bridge_error(StatusCode::BAD_GATEWAY, error);
    }

    let snapshot = state.store.snapshot().await;
    let entry_files = snapshot
        .cache_entries
        .iter()
        .find(|entry| {
            entry.info_hash == id
                || entry.torrent_id.map(|value| value.to_string()).as_deref() == Some(id.as_str())
        })
        .map(|entry| entry.files.clone())
        .unwrap_or_default();
    let download_dir = state.current_download_dir().await;
    remove_entry_files(&download_dir, &entry_files).await;
    if let Err(error) = state.store.remove_cache_entry(&id).await {
        return bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error);
    }
    let remaining = state.store.snapshot().await.cache_entries;
    remove_deleted_torrent_trees(&download_dir, &entry_files, &remaining).await;
    StatusCode::NO_CONTENT.into_response()
}

async fn clear_cache(State(state): State<BridgeState>, headers: HeaderMap) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    let download_dir = state.current_download_dir().await;
    match empty_cache(&state, &download_dir).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

/// Deletes every torrent rqbit still knows, drops the cache index, and wipes
/// `download_dir`. Used by explicit clear and by a directory swap.
async fn empty_cache(state: &BridgeState, download_dir: &std::path::Path) -> Result<(), String> {
    delete_all_torrents(state).await?;
    state.store.clear_cache_entries().await?;
    let download_dir = download_dir.to_path_buf();
    tokio::task::spawn_blocking(move || wipe_dir_contents(&download_dir))
        .await
        .map_err(|error| error.to_string())?
}

/// Asks rqbit to delete a torrent and its files. Returns Ok whether it
/// deleted or simply didn't know the torrent (post-restart orphans).
async fn rqbit_delete(state: &BridgeState, id: &str) -> Result<(), String> {
    let response = state
        .client
        .post(format!(
            "http://127.0.0.1:{}/torrents/{}/delete",
            state.rqbit_port,
            urlencoding::encode(id)
        ))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err(format!(
            "rqbit could not delete torrent {id} ({})",
            response.status()
        ))
    }
}

/// Removes an entry's recorded files from disk and prunes the empty folders
/// they leave behind. Paths outside the download directory are refused.
async fn remove_entry_files(download_dir: &std::path::Path, files: &[String]) {
    let download_dir = download_dir.to_path_buf();
    let files = files.to_vec();
    let _ = tokio::task::spawn_blocking(move || {
        for file in &files {
            let path = std::path::Path::new(file);
            // `starts_with` compares components without collapsing "..", so
            // "<cache>/../../etc/x" would pass it while remove_file resolves
            // the ".." and escapes. Recorded names come from torrent metadata
            // (untrusted); refuse any parent-directory component outright.
            let has_parent_component = path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir));
            if has_parent_component || !path.starts_with(&download_dir) {
                continue;
            }
            let _ = std::fs::remove_file(path);
            let mut parent = path.parent();
            while let Some(dir) = parent {
                if dir == download_dir.as_path() {
                    break;
                }
                // remove_dir only succeeds on empty directories, so this
                // stops naturally at folders that still hold other files.
                if std::fs::remove_dir(dir).is_err() {
                    break;
                }
                parent = dir.parent();
            }
        }
    })
    .await;
}

/// After a torrent drop, wipe that title's top-level folder (or file) if
/// nothing still in the index lives there. rqbit delete can leave sparse
/// siblings that `metadata.len()` still counts against the 10 GB cap.
async fn remove_deleted_torrent_trees(
    download_dir: &std::path::Path,
    deleted_files: &[String],
    remaining: &[store::CacheEntry],
) {
    let download_dir = download_dir.to_path_buf();
    let deleted = deleted_files.to_vec();
    let remaining_files: Vec<String> = remaining
        .iter()
        .flat_map(|entry| entry.files.iter().cloned())
        .collect();
    let _ = tokio::task::spawn_blocking(move || {
        wipe_unclaimed_roots(&download_dir, &deleted, &remaining_files);
    })
    .await;
}

fn wipe_unclaimed_roots(
    download_dir: &std::path::Path,
    deleted_files: &[String],
    remaining_files: &[String],
) {
    let mut roots = HashSet::new();
    for file in deleted_files {
        if let Some(root) = cache_root_of(download_dir, std::path::Path::new(file)) {
            roots.insert(root);
        }
    }
    for root in roots {
        let claimed = remaining_files
            .iter()
            .any(|path| std::path::Path::new(path).starts_with(&root));
        if claimed {
            continue;
        }
        if root.is_dir() {
            let _ = std::fs::remove_dir_all(&root);
        } else {
            let _ = std::fs::remove_file(&root);
        }
    }
}

fn cache_root_of(download_dir: &std::path::Path, file: &std::path::Path) -> Option<std::path::PathBuf> {
    let relative = file.strip_prefix(download_dir).ok()?;
    let first = relative.components().next()?;
    Some(download_dir.join(first))
}

fn wipe_dir_contents(dir: &std::path::Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let result = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(error) = result {
            return Err(format!("could not remove {}: {error}", path.display()));
        }
    }
    Ok(())
}

async fn cache_maintenance_loop(state: BridgeState) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if let Err(error) = enforce_cache_limit(&state).await {
            tracing::warn!(target: "engine", error = %error, "cache maintenance failed");
        }
        if let Err(error) = apply_download_window(&state).await {
            tracing::warn!(target: "engine", error = %error, "download window failed");
        }
    }
}

async fn enforce_cache_limit(state: &BridgeState) -> Result<(), String> {
    let snapshot = state.store.snapshot().await;
    let download_dir = state.current_download_dir().await;
    let transcode_dir = state.transcode.dir().to_path_buf();
    let free_bytes = system::volume_free_bytes(&download_dir);
    let tight = cache::disk_is_tight(free_bytes);
    state.disk_pressure.store(tight, Ordering::Release);

    let mut used_bytes = cache_size(download_dir.clone(), transcode_dir).await?;
    let over_budget = used_bytes > snapshot.cache.max_bytes;
    if !over_budget && !tight {
        return Ok(());
    }

    let playing = state.is_playback_active();
    let now = store::now_millis();
    let active_id = playing
        .then(|| {
            snapshot
                .cache_entries
                .iter()
                .max_by_key(|entry| entry.last_accessed_at)
                .map(cache_entry_id)
        })
        .flatten();

    let mut deleted_files: Vec<String> = Vec::new();
    let mut entries = snapshot.cache_entries;
    entries.sort_by_key(|entry| entry.last_accessed_at);
    for entry in entries {
        if used_bytes <= snapshot.cache.max_bytes && !tight {
            break;
        }
        let id = cache_entry_id(&entry);
        if cache_entry_is_protected(&entry, now, playing, active_id.as_deref()) {
            continue;
        }
        // Delete through rqbit when it still knows the torrent, and always
        // remove the recorded files — after a restart only the files exist.
        if rqbit_delete(state, &id).await.is_ok() {
            let freed = entry_files_size(&entry.files).await;
            remove_entry_files(&download_dir, &entry.files).await;
            deleted_files.extend(entry.files.iter().cloned());
            state.store.remove_cache_entry(&id).await?;
            used_bytes = used_bytes.saturating_sub(freed);
        }
    }

    // Playback finished (or never started): the last title can go too if it
    // still blows the budget — except a title still inside the startup
    // grace, which has not had time to produce segments yet.
    if !playing && used_bytes > snapshot.cache.max_bytes {
        let leftover = state.store.snapshot().await.cache_entries;
        for entry in leftover {
            if used_bytes <= snapshot.cache.max_bytes {
                break;
            }
            if entry_in_startup_grace(&entry, now) {
                continue;
            }
            let id = cache_entry_id(&entry);
            if rqbit_delete(state, &id).await.is_ok() {
                let freed = entry_files_size(&entry.files).await;
                remove_entry_files(&download_dir, &entry.files).await;
                deleted_files.extend(entry.files.iter().cloned());
                state.store.remove_cache_entry(&id).await?;
                used_bytes = used_bytes.saturating_sub(freed);
            }
        }
    }

    if !deleted_files.is_empty() {
        let remaining = state.store.snapshot().await.cache_entries;
        remove_deleted_torrent_trees(&download_dir, &deleted_files, &remaining).await;
    }

    if used_bytes <= snapshot.cache.max_bytes {
        return Ok(());
    }
    if playing || state.store.snapshot().await.cache_entries.iter().any(|entry| {
        entry_in_startup_grace(entry, now)
    }) {
        return Ok(());
    }

    // Still over: untracked leftovers (downloaded before file paths were
    // recorded). Skip files written during the startup grace so a just-
    // started title is not reclaimed out from under ffmpeg.
    let max_bytes = snapshot.cache.max_bytes;
    tokio::task::spawn_blocking(move || reclaim_untracked(&download_dir, max_bytes))
        .await
        .map_err(|error| error.to_string())?
}

fn cache_entry_id(entry: &store::CacheEntry) -> String {
    entry
        .torrent_id
        .map(|value| value.to_string())
        .unwrap_or_else(|| entry.info_hash.clone())
}

fn entry_in_startup_grace(entry: &store::CacheEntry, now: u64) -> bool {
    now.saturating_sub(entry.last_accessed_at) < CACHE_STARTUP_GRACE_MS
}

fn cache_entry_is_protected(
    entry: &store::CacheEntry,
    now: u64,
    playing: bool,
    active_id: Option<&str>,
) -> bool {
    if entry_in_startup_grace(entry, now) {
        return true;
    }
    let id = cache_entry_id(entry);
    playing && active_id == Some(id.as_str())
}

/// Pause background torrents only. The title being watched (or just added)
/// keeps peers so remux/ffprobe can read the header. rqbit is not
/// sequential — a 512 MB "window" is random pieces, not a playable prefix,
/// and pausing on it is what made starts hang. The 10 GB reserve evicts
/// *other* titles; we only pause the active one when the volume is about
/// to hit ENOSPC.
async fn apply_download_window(state: &BridgeState) -> Result<(), String> {
    let torrents = rqbit_list_torrents(state).await?;
    if torrents.is_empty() {
        return Ok(());
    }

    let download_dir = state.current_download_dir().await;
    let critical = cache::disk_is_critical(system::volume_free_bytes(&download_dir));
    let playing = state.is_playback_active();
    let snapshot = state.store.snapshot().await;
    let now = store::now_millis();
    let active = snapshot
        .cache_entries
        .iter()
        .max_by_key(|entry| entry.last_accessed_at)
        .filter(|entry| playing || entry_in_startup_grace(entry, now));

    for torrent in torrents {
        let is_active = active.is_some_and(|entry| {
            entry.info_hash == torrent
                || entry.torrent_id.map(|id| id.to_string()).as_deref() == Some(torrent.as_str())
        });
        if !is_active {
            let _ = rqbit_pause(state, &torrent).await;
            continue;
        }

        if critical {
            let _ = rqbit_pause(state, &torrent).await;
        } else {
            let _ = rqbit_start(state, &torrent).await;
        }
    }
    Ok(())
}

fn reclaim_untracked(dir: &std::path::Path, max_bytes: u64) -> Result<(), String> {
    let mut used_bytes = directory_size(dir).map_err(|error| error.to_string())?;
    let mut items: Vec<(std::path::PathBuf, std::time::SystemTime)> = std::fs::read_dir(dir)
        .map_err(|error| error.to_string())?
        .flatten()
        .filter_map(|entry| {
            let modified = entry.metadata().and_then(|meta| meta.modified()).ok()?;
            Some((entry.path(), modified))
        })
        .collect();
    items.sort_by_key(|(_, modified)| *modified);
    let grace_floor = std::time::SystemTime::now()
        .checked_sub(Duration::from_millis(CACHE_STARTUP_GRACE_MS))
        .unwrap_or(std::time::UNIX_EPOCH);

    for (path, modified) in items {
        if used_bytes <= max_bytes {
            return Ok(());
        }
        if modified > grace_floor {
            continue;
        }
        let freed = if path.is_dir() {
            directory_size(&path).unwrap_or(0)
        } else {
            path.metadata().map(|meta| meta.len()).unwrap_or(0)
        };
        let _ = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        used_bytes = used_bytes.saturating_sub(freed);
    }
    Ok(())
}

/// Sums the sizes of an entry's recorded files. Missing files count as zero —
/// they were already gone before eviction ran.
async fn entry_files_size(files: &[String]) -> u64 {
    let files = files.to_vec();
    tokio::task::spawn_blocking(move || {
        files
            .iter()
            .map(|file| {
                std::path::Path::new(file)
                    .metadata()
                    .map(|meta| meta.len())
                    .unwrap_or(0)
            })
            .sum()
    })
    .await
    .unwrap_or(0)
}

async fn delete_all_torrents(state: &BridgeState) -> Result<(), String> {
    let response = state
        .client
        .get(format!("http://127.0.0.1:{}/torrents", state.rqbit_port))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let list = response
        .json::<TorrentListResponse>()
        .await
        .map_err(|error| error.to_string())?;
    // Best effort per torrent: one stuck torrent must not block clearing the
    // rest (the directory wipe afterwards reclaims its files regardless).
    for torrent in list.torrents {
        let id = torrent
            .id
            .map(|value| value.to_string())
            .unwrap_or(torrent.info_hash);
        if let Err(error) = rqbit_delete(state, &id).await {
            tracing::error!(target: "engine", error = %error, "cache clear failed");
        }
    }
    Ok(())
}

async fn cache_size(download_dir: PathBuf, transcode_dir: PathBuf) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || {
        Ok::<u64, std::io::Error>(
            directory_size(&download_dir)? + directory_size(&transcode_dir)?,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

async fn rqbit_list_torrents(state: &BridgeState) -> Result<Vec<String>, String> {
    let response = state
        .client
        .get(format!("http://127.0.0.1:{}/torrents", state.rqbit_port))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let list = response
        .json::<TorrentListResponse>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(list
        .torrents
        .into_iter()
        .map(|torrent| {
            torrent
                .id
                .map(|value| value.to_string())
                .unwrap_or(torrent.info_hash)
        })
        .collect())
}

async fn rqbit_pause(state: &BridgeState, id: &str) -> Result<(), String> {
    rqbit_action(state, id, "pause").await
}

async fn rqbit_start(state: &BridgeState, id: &str) -> Result<(), String> {
    rqbit_action(state, id, "start").await
}

/// Playback and remux read through rqbit's stream endpoint. If the
/// maintainer paused this torrent, ffmpeg sits on a socket that never
/// receives pieces — unpause and refresh the playback guard first.
async fn ensure_torrent_running(state: &BridgeState, id: &str) -> Result<(), String> {
    let download_dir = state.current_download_dir().await;
    if cache::disk_is_critical(system::volume_free_bytes(&download_dir)) {
        let _ = rqbit_pause(state, id).await;
        return Err("Cubo's cache disk is almost full. Free disk space before trying playback again.".into());
    }
    state.mark_playback();
    if let Err(error) = rqbit_start(state, id).await {
        tracing::debug!(target: "engine", error = %error, id, "could not start torrent");
    }
    Ok(())
}

async fn rqbit_action(state: &BridgeState, id: &str, action: &str) -> Result<(), String> {
    let response = state
        .client
        .post(format!(
            "http://127.0.0.1:{}/torrents/{id}/{action}",
            state.rqbit_port
        ))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() || response.status().as_u16() == 404 {
        return Ok(());
    }
    Err(format!("rqbit {action} failed ({})", response.status()))
}

fn directory_size(path: &std::path::Path) -> std::io::Result<u64> {
    let mut size = 0;
    if !path.exists() {
        return Ok(0);
    }
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            size += directory_size(&entry.path())?;
        } else {
            size += metadata.len();
        }
    }
    Ok(size)
}

/// `/api/*` is Core's catalog/stream/subtitle proxies. Everything else is
/// the Vite app: debug proxies the local dev server (including HMR sockets);
/// release serves the embedded `dist`.
async fn web_fallback(
    State(state): State<BridgeState>,
    request: axum::extract::Request,
) -> Response {
    if request.uri().path().starts_with("/api/") {
        return crate::catalog::proxy(&state.client, request).await;
    }

    let Some(web_origin) = state.web_origin.clone() else {
        return crate::web_static::serve(request.uri().path());
    };

    let is_socket_upgrade = request
        .headers()
        .get(axum::http::header::UPGRADE)
        .is_some_and(|value| value == "websocket");
    if is_socket_upgrade {
        let (mut parts, body) = request.into_parts();
        return match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
            Ok(upgrade) => proxy_web_socket(
                web_origin,
                upgrade,
                axum::extract::Request::from_parts(parts, body),
            ),
            Err(_) => StatusCode::BAD_REQUEST.into_response(),
        };
    }

    proxy_web_app(state, web_origin, request).await
}

async fn proxy_web_app(
    state: BridgeState,
    web_origin: Arc<str>,
    request: axum::extract::Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let path = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let upstream_url = format!("{}{path}", web_origin);
    let mut upstream = state.client.request(parts.method, upstream_url);

    for (name, value) in &parts.headers {
        if !is_hop_by_hop(name.as_str()) && name.as_str() != "host" {
            upstream = upstream.header(name, value);
        }
    }

    let body = match to_bytes(body, WEB_PROXY_BODY_LIMIT).await {
        Ok(body) => body,
        Err(error) => return bridge_error(StatusCode::PAYLOAD_TOO_LARGE, error.to_string()),
    };
    if !body.is_empty() {
        upstream = upstream.body(body);
    }

    match upstream.timeout(WEB_PROXY_TIMEOUT).send().await {
        Ok(response) => proxy_web_response(response),
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error.to_string()),
    }
}

fn proxy_web_socket(
    web_origin: Arc<str>,
    web_socket: WebSocketUpgrade,
    request: axum::extract::Request,
) -> Response {
    let mut upstream_url = match reqwest::Url::parse(web_origin.as_ref()) {
        Ok(url) => url,
        Err(error) => return bridge_error(StatusCode::BAD_GATEWAY, error.to_string()),
    };
    let scheme = if upstream_url.scheme() == "https" {
        "wss"
    } else {
        "ws"
    };
    if upstream_url.set_scheme(scheme).is_err() {
        return bridge_error(StatusCode::BAD_GATEWAY, "invalid web socket scheme".into());
    }
    upstream_url.set_path(request.uri().path());
    upstream_url.set_query(request.uri().query());

    web_socket.on_upgrade(move |socket| relay_web_socket(socket, upstream_url.to_string()))
}

async fn relay_web_socket(client: WebSocket, upstream_url: String) {
    let Ok((upstream, _)) = tokio_tungstenite::connect_async(upstream_url).await else {
        return;
    };
    let (mut client_sender, mut client_receiver) = client.split();
    let (mut upstream_sender, mut upstream_receiver) = upstream.split();

    loop {
        tokio::select! {
            client_message = client_receiver.next() => {
                let Some(Ok(message)) = client_message else { break };
                let close = matches!(message, AxumMessage::Close(_));
                if let Some(message) = to_upstream_message(message) {
                    if upstream_sender.send(message).await.is_err() { break; }
                }
                if close { break; }
            }
            upstream_message = upstream_receiver.next() => {
                let Some(Ok(message)) = upstream_message else { break };
                let close = matches!(message, TungsteniteMessage::Close(_));
                if let Some(message) = to_client_message(message) {
                    if client_sender.send(message).await.is_err() { break; }
                }
                if close { break; }
            }
        }
    }
}

fn to_upstream_message(message: AxumMessage) -> Option<TungsteniteMessage> {
    match message {
        AxumMessage::Text(value) => Some(TungsteniteMessage::Text(value.to_string().into())),
        AxumMessage::Binary(value) => Some(TungsteniteMessage::Binary(value)),
        AxumMessage::Ping(value) => Some(TungsteniteMessage::Ping(value)),
        AxumMessage::Pong(value) => Some(TungsteniteMessage::Pong(value)),
        AxumMessage::Close(_) => Some(TungsteniteMessage::Close(None)),
    }
}

fn to_client_message(message: TungsteniteMessage) -> Option<AxumMessage> {
    match message {
        TungsteniteMessage::Text(value) => Some(AxumMessage::Text(value.to_string().into())),
        TungsteniteMessage::Binary(value) => Some(AxumMessage::Binary(value)),
        TungsteniteMessage::Ping(value) => Some(AxumMessage::Ping(value)),
        TungsteniteMessage::Pong(value) => Some(AxumMessage::Pong(value)),
        TungsteniteMessage::Close(_) => Some(AxumMessage::Close(None)),
        TungsteniteMessage::Frame(_) => None,
    }
}

/// `only_files` and `only_files_regex` are mutually exclusive in rqbit.
/// Prefer a Torrentio file index; otherwise match SxxEyy inside a pack.
fn rqbit_add_url(
    rqbit_port: u16,
    download_dir: &std::path::Path,
    file_index: Option<usize>,
    episode_regex: Option<String>,
) -> String {
    let mut url = format!(
        "http://127.0.0.1:{}/torrents?overwrite=true&output_folder={}",
        rqbit_port,
        urlencoding::encode(&download_dir.to_string_lossy())
    );
    if let Some(index) = file_index {
        url.push_str(&format!("&only_files={index}"));
    } else if let Some(regex) = episode_regex {
        url.push_str(&format!(
            "&only_files_regex={}",
            urlencoding::encode(&regex)
        ));
    }
    url
}

/// `tv:236235:2:1` → filename regex for S02E01 / 2x01. Movies and
/// incomplete keys (`tv:123:-:-`) produce nothing.
fn episode_file_regex(media_key: Option<&str>) -> Option<String> {
    let key = media_key?;
    let mut parts = key.split(':');
    let kind = parts.next()?;
    if !kind.eq_ignore_ascii_case("tv") {
        return None;
    }
    let _id = parts.next()?;
    let season: u32 = parts.next()?.parse().ok()?;
    let episode: u32 = parts.next()?.parse().ok()?;
    if season == 0 || episode == 0 {
        return None;
    }
    Some(format!(
        r"(?i)(?:s0*{season}[ ._\-]?e0*{episode}|{season}x0*{episode})(?:\D|$)"
    ))
}

async fn add_torrent(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }

    let download_dir = state.current_download_dir().await;
    if cache::disk_is_critical(system::volume_free_bytes(&download_dir)) {
        return bridge_error(
            StatusCode::INSUFFICIENT_STORAGE,
            "Cubo's cache disk is almost full. Free disk space before trying playback again.".into(),
        );
    }

    let media_key = headers
        .get("x-cubo-media-key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let title = headers
        .get("x-cubo-title")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| urlencoding::decode(value).ok())
        .map(|value| value.into_owned());
    let file_index = headers
        .get("x-cubo-file-index")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());

    match state
        .client
        .post(rqbit_add_url(
            state.rqbit_port,
            &download_dir,
            file_index,
            episode_file_regex(media_key.as_deref()),
        ))
        .body(body)
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            let response_headers = response.headers().clone();
            let bytes = match response.bytes().await {
                Ok(bytes) => bytes,
                Err(error) => return bridge_error(StatusCode::BAD_GATEWAY, error.to_string()),
            };

            if status.is_success() {
                // Cover the gap before the first segment marks playback, so
                // the 5s maintainer does not pause this torrent on add.
                state.mark_playback();
                let parsed = serde_json::from_slice::<serde_json::Value>(&bytes).ok();
                let torrent_id = parsed
                    .as_ref()
                    .and_then(|value| value.get("id"))
                    .and_then(serde_json::Value::as_u64);
                let info_hash = parsed
                    .as_ref()
                    .and_then(|value| {
                        value
                            .get("info_hash")
                            .or_else(|| value.pointer("/details/info_hash"))
                    })
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if !info_hash.is_empty() {
                    tracing::info!(
                        target: "engine",
                        torrent_id = torrent_id.unwrap_or(0),
                        info_hash = %info_hash,
                        media_key = media_key.as_deref().unwrap_or("-"),
                        title = title.as_deref().unwrap_or("-"),
                        "torrent added"
                    );
                    // Record absolute file paths so cache deletion keeps
                    // working after restarts, when rqbit no longer knows the
                    // torrent but the files are still on disk.
                    let output_folder = parsed
                        .as_ref()
                        .and_then(|value| {
                            value
                                .get("output_folder")
                                .or_else(|| value.pointer("/details/output_folder"))
                        })
                        .and_then(serde_json::Value::as_str);
                    let files = match output_folder {
                        Some(folder) => parsed
                            .as_ref()
                            .and_then(|value| value.pointer("/details/files"))
                            .and_then(serde_json::Value::as_array)
                            .map(|files| {
                                files
                                    .iter()
                                    .enumerate()
                                    .filter(|(index, file)| {
                                        if let Some(wanted) = file_index {
                                            return *index == wanted;
                                        }
                                        file.get("included")
                                            .and_then(serde_json::Value::as_bool)
                                            .unwrap_or(true)
                                    })
                                    .filter_map(|(_, file)| {
                                        file.get("name").and_then(serde_json::Value::as_str)
                                    })
                                    .map(|name| {
                                        std::path::Path::new(folder)
                                            .join(name)
                                            .to_string_lossy()
                                            .into_owned()
                                    })
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default(),
                        None => Vec::new(),
                    };
                    if let Err(error) = state
                        .store
                        .touch_cache(torrent_id, info_hash.clone(), media_key, title, files)
                        .await
                    {
                        tracing::warn!(target: "engine", error = %error, "could not update cache index");
                    }
                }

                // Apply the existing one-active-download policy now; a
                // fallback should not leave the previous swarm writing until
                // the next maintenance tick.
                let download_state = state.clone();
                tokio::spawn(async move {
                    if let Err(error) = apply_download_window(&download_state).await {
                        tracing::warn!(target: "engine", error = %error, "could not pause background downloads after add");
                    }
                });

                // MKV files can only play through the remux pipeline, which
                // needs an ffprobe first. Warm it now, in parallel with the
                // torrent buffering, so the playlist request doesn't pay for
                // it serially. (Direct-play MP4s never need a probe.)
                if !info_hash.is_empty() {
                    let torrent_key = torrent_id
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| info_hash.clone());
                    let largest_mkv = parsed
                        .as_ref()
                        .and_then(|value| value.pointer("/details/files"))
                        .and_then(serde_json::Value::as_array)
                        .and_then(|files| {
                            let is_mkv = |file: &serde_json::Value| {
                                file.get("name")
                                    .and_then(serde_json::Value::as_str)
                                    .is_some_and(|name| {
                                        name.to_ascii_lowercase().ends_with(".mkv")
                                    })
                            };
                            if let Some(index) = file_index.filter(|&index| {
                                files.get(index).is_some_and(is_mkv)
                            }) {
                                return Some(index);
                            }
                            files
                                .iter()
                                .enumerate()
                                .filter(|(_, file)| {
                                    file.get("included")
                                        .and_then(serde_json::Value::as_bool)
                                        .unwrap_or(true)
                                        && is_mkv(file)
                                })
                                .max_by_key(|(_, file)| {
                                    file.get("length").and_then(serde_json::Value::as_u64)
                                })
                                .map(|(index, _)| index)
                        });
                    if let Some(file_index) = largest_mkv {
                        let key = format!("{torrent_key}:{file_index}");
                        let input_url = format!(
                            "http://127.0.0.1:{}/torrents/{torrent_key}/stream/{file_index}",
                            state.rqbit_port
                        );
                        let transcode = state.transcode.clone();
                        tokio::spawn(async move {
                            transcode.prewarm(key, input_url).await;
                        });
                    }
                }
            }

            let mut builder = Response::builder().status(status);
            if let Some(content_type) = response_headers.get(CONTENT_TYPE) {
                builder = builder.header(CONTENT_TYPE, content_type);
            }
            builder.body(Body::from(bytes)).unwrap_or_else(|error| {
                bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            })
        }
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error.to_string()),
    }
}

async fn torrent_stats(
    State(state): State<BridgeState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    // Buffering polls this until the torrent is live — treat that as watching
    // so a directory swap cannot yank the files out from under a start,
    // and unpause if the maintainer already stopped peers.
    if let Err(error) = ensure_torrent_running(&state, &id).await {
        return bridge_error(StatusCode::INSUFFICIENT_STORAGE, error);
    }

    match state
        .client
        .get(format!(
            "http://127.0.0.1:{}/torrents/{id}/stats/v1",
            state.rqbit_port
        ))
        .send()
        .await
    {
        Ok(response) => proxy_response(response),
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error.to_string()),
    }
}

async fn stream_torrent(
    State(state): State<BridgeState>,
    Path((id, file_index)): Path<(String, usize)>,
    Query(query): Query<StreamQuery>,
    headers: HeaderMap,
) -> Response {
    if !is_valid_token(&state, &query.token) {
        return unauthorized();
    }
    if let Err(error) = ensure_torrent_running(&state, &id).await {
        return bridge_error(StatusCode::INSUFFICIENT_STORAGE, error);
    }

    let mut request = state.client.get(format!(
        "http://127.0.0.1:{}/torrents/{id}/stream/{file_index}",
        state.rqbit_port
    ));
    if let Some(range) = headers.get(RANGE) {
        request = request.header(RANGE, range);
    }

    match request.send().await {
        Ok(response) => proxy_response(response),
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error.to_string()),
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SubtitleMatchInfo {
    video_hash: String,
    video_size: u64,
    filename: String,
}

/// Release-matching data for external subtitles. OpenSubtitles hashes
/// identify the EXACT release, so a matched track is synced by construction
/// instead of being timed against whatever copy its author used — the root
/// cause of badly-synced subs when matching by IMDb ID alone.
async fn torrent_subtitle_match(
    State(state): State<BridgeState>,
    Path((id, file_index)): Path<(String, usize)>,
    headers: HeaderMap,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    let key = format!("{id}:{file_index}");
    if let Some(hit) = state.subtitle_matches.lock().await.get(&key) {
        return Json(hit.clone()).into_response();
    }

    // File metadata from rqbit. Some responses keep details under "details",
    // others at the top level; accept both, like add_torrent does.
    let details = match state
        .client
        .get(format!(
            "http://127.0.0.1:{}/torrents/{id}",
            state.rqbit_port
        ))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return bridge_error(StatusCode::BAD_GATEWAY, error.to_string()),
    };
    if !details.status().is_success() {
        return bridge_error(
            StatusCode::NOT_FOUND,
            format!("torrent {id} is not known to this Core"),
        );
    }
    let parsed = match details.json::<serde_json::Value>().await {
        Ok(value) => value,
        Err(error) => return bridge_error(StatusCode::BAD_GATEWAY, error.to_string()),
    };
    let files = parsed
        .pointer("/files")
        .or_else(|| parsed.pointer("/details/files"))
        .and_then(serde_json::Value::as_array);
    let Some(files) = files else {
        return bridge_error(StatusCode::BAD_GATEWAY, "torrent has no file list".into());
    };
    let Some(file) = files.get(file_index) else {
        return bridge_error(StatusCode::NOT_FOUND, "file index out of range".into());
    };
    let Some(filename) = file.get("name").and_then(serde_json::Value::as_str) else {
        return bridge_error(StatusCode::BAD_GATEWAY, "torrent file has no name".into());
    };
    let Some(size) = file.get("length").and_then(serde_json::Value::as_u64) else {
        return bridge_error(StatusCode::BAD_GATEWAY, "torrent file has no length".into());
    };

    let stream_url = format!(
        "http://127.0.0.1:{}/torrents/{id}/stream/{file_index}",
        state.rqbit_port
    );
    let hash = match release_hash(&state.client, &stream_url, size).await {
        Ok(hash) => hash,
        Err(error) => return bridge_error(StatusCode::BAD_GATEWAY, error),
    };

    let info = SubtitleMatchInfo {
        video_hash: format!("{hash:016x}"),
        video_size: size,
        filename: filename.to_owned(),
    };
    {
        let mut cached = state.subtitle_matches.lock().await;
        if cached.len() >= 16 {
            cached.clear();
        }
        cached.insert(key, info.clone());
    }
    Json(info).into_response()
}

const RELEASE_HASH_CHUNK: u64 = 65_536;

/// OpenSubtitles movie hash: the file size plus wrapped u64 sums over both
/// edge 64 KiB chunks. Reads go through rqbit's ranged stream endpoint, so
/// the tail is pulled from peers on demand — this works even while the
/// torrent is still downloading, and piece verification guarantees the bytes
/// are the real release's.
async fn release_hash(
    client: &reqwest::Client,
    stream_url: &str,
    size: u64,
) -> Result<u64, String> {
    if size < RELEASE_HASH_CHUNK * 2 {
        return Err("file too small for release hashing".into());
    }
    let head = read_stream_range(client, stream_url, 0, RELEASE_HASH_CHUNK - 1).await?;
    let tail = read_stream_range(client, stream_url, size - RELEASE_HASH_CHUNK, size - 1).await?;
    combine_release_hash(size, &head, &tail)
}

/// OpenSubtitles hash arithmetic over the two edge chunks: seed with the
/// file size, then wrapped-add every little-endian u64 word.
fn combine_release_hash(size: u64, head: &[u8], tail: &[u8]) -> Result<u64, String> {
    if head.len() as u64 != RELEASE_HASH_CHUNK || tail.len() as u64 != RELEASE_HASH_CHUNK {
        return Err("short read while hashing".into());
    }
    let mut hash = size;
    for chunk in [head, tail] {
        for word in chunk.chunks_exact(8) {
            hash = hash.wrapping_add(u64::from_le_bytes(word.try_into().expect("8 bytes")));
        }
    }
    Ok(hash)
}

async fn read_stream_range(
    client: &reqwest::Client,
    url: &str,
    start: u64,
    end_inclusive: u64,
) -> Result<Bytes, String> {
    let response = client
        .get(url)
        .header(RANGE, format!("bytes={start}-{end_inclusive}"))
        .timeout(Duration::from_secs(45))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("stream range read failed ({})", response.status()));
    }
    response.bytes().await.map_err(|error| error.to_string())
}

/// Serves the remux pipeline for one torrent file. `media.m3u8` starts (or
/// reuses) the ffmpeg job and returns the playlist with the session token
/// appended to every segment URI; any other name serves a segment from disk.
async fn hls_file(
    State(state): State<BridgeState>,
    Path((id, file_index, file)): Path<(String, usize, String)>,
    Query(query): Query<HlsQuery>,
) -> Response {
    if !is_valid_token(&state, &query.token) {
        return unauthorized();
    }
    if let Err(error) = ensure_torrent_running(&state, &id).await {
        return bridge_error(StatusCode::INSUFFICIENT_STORAGE, error);
    }
    if !state.transcode.available() {
        return bridge_error(
            StatusCode::NOT_IMPLEMENTED,
            "ffmpeg is not available on this Core".into(),
        );
    }
    let key = format!("{id}:{file_index}");
    let start = query.start.unwrap_or(0.0).max(0.0);

    if file == "media.m3u8" {
        // hls.js polls this URL every few seconds while the playlist grows.
        // A running job's playlist is served straight from disk — probing the
        // source again here blocked every poll behind a fresh ffprobe.
        // `gen` distinguishes a real seek restart from a leftover poll of
        // the previous `start=` URL (which must not kill the new remux).
        if !state.transcode.job_usable(&key, start, query.gen).await {
            let input_url = format!(
                "http://127.0.0.1:{}/torrents/{id}/stream/{file_index}",
                state.rqbit_port
            );
            // Seek restarts and prewarmed torrents reuse a cached probe; only
            // a cold file pays for ffprobe here, and the result is remembered.
            let probe = match state.transcode.cached_probe(&key).await {
                Some(probe) => probe,
                None => match state.transcode.probe(&input_url).await {
                    Ok(probe) => {
                        state.transcode.remember_probe(&key, probe.clone()).await;
                        probe
                    }
                    Err(error) => return bridge_error(StatusCode::BAD_GATEWAY, error),
                },
            };
            if !probe.video_copyable() {
                return bridge_error(
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    format!(
                        "video codec {} cannot be converted quickly",
                        probe.video_codec.as_deref().unwrap_or("unknown")
                    ),
                );
            }
            if let Err(error) = state
                .transcode
                .ensure_job(&key, &input_url, &probe, start, query.gen.unwrap_or(0))
                .await
            {
                return bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error);
            }
        }

        let Some(job_dir) = state.transcode.job_dir(&key).await else {
            return bridge_error(StatusCode::NOT_FOUND, "no conversion is running".into());
        };
        if let Err(error) = state.transcode.wait_for_playlist(&job_dir).await {
            return bridge_error(StatusCode::GATEWAY_TIMEOUT, error);
        }
        let duration = state.transcode.job_duration(&key).await;
        let actual_start = state.transcode.job_actual_start(&key).await;
        let nonce = state.transcode.job_nonce(&key).await.unwrap_or_default();

        let content = match read_growing_playlist(&job_dir.join("media.m3u8")).await {
            Ok(content) => {
                state.transcode.remember_playlist(&key, content.clone()).await;
                Some(content)
            }
            Err(error) => {
                // Prefer the last good playlist over a 404 — hls.js recovers
                // a missing EVENT playlist by jumping to the live edge.
                if let Some(cached) = state.transcode.last_playlist(&key).await {
                    tracing::debug!(target: "engine", error = %error, "playlist read missed a rewrite; serving last good");
                    Some(cached)
                } else {
                    tracing::debug!(target: "engine", error = %error, "playlist read missed a rewrite");
                    None
                }
            }
        };
        let Some(content) = content else {
            return bridge_error(StatusCode::SERVICE_UNAVAILABLE, "playlist not ready".into());
        };

        let mut response = (
            [
                (CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                (HeaderName::from_static("cache-control"), "no-store"),
            ],
            // Echo back the token the caller authorized with — never
            // the session token, which a paired device must not see.
            rewrite_playlist(&content, &query.token, &nonce),
        )
            .into_response();
        if let Some(duration) = duration {
            if let Ok(value) = HeaderValue::from_str(&duration.to_string()) {
                response
                    .headers_mut()
                    .insert(HeaderName::from_static("x-cubo-duration"), value);
            }
        }
        if let Some(actual_start) = actual_start {
            if let Ok(value) = HeaderValue::from_str(&format!("{actual_start:.3}")) {
                response
                    .headers_mut()
                    .insert(HeaderName::from_static("x-cubo-start"), value);
            }
        }
        return response;
    }

    // Segment fetches stop when the player is paused; playlist polls do not.
    state.mark_playback();

    // Segment names come from ffmpeg; refuse anything that could escape the
    // job directory.
    if file.contains('/') || file.contains('\\') || file.contains("..") {
        return bridge_error(StatusCode::BAD_REQUEST, "invalid segment name".into());
    }
    let Some(job_dir) = state.transcode.job_dir(&key).await else {
        return bridge_error(StatusCode::NOT_FOUND, "no conversion is running".into());
    };
    match tokio::fs::read(job_dir.join(&file)).await {
        Ok(bytes) => {
            let content_type = if file.ends_with(".mp4") {
                "video/mp4"
            } else if file.ends_with(".m4s") {
                "video/iso.segment"
            } else {
                "application/octet-stream"
            };
            // Seek restarts reuse segment names in a fresh job; a cached
            // response from the previous offset would splice wrong video in.
            (
                [
                    (CONTENT_TYPE, content_type),
                    (HeaderName::from_static("cache-control"), "no-store"),
                ],
                bytes,
            )
                .into_response()
        }
        Err(_) => bridge_error(StatusCode::NOT_FOUND, "segment not found".into()),
    }
}

/// HLS players fetch segment URIs verbatim, so the session token rides along
/// as a query parameter on every entry — plus the job nonce, which makes each
/// conversion's segment URLs unique. Seek restarts reuse segment names for
/// different content, and a cached response from a previous job would splice
/// mismatched audio/video into playback.
fn rewrite_playlist(content: &str, token: &str, nonce: &str) -> String {
    let params = format!("token={token}&v={nonce}");
    content
        .lines()
        .map(|line| {
            if line.starts_with("#EXT-X-MAP") {
                line.replace("URI=\"init.mp4\"", &format!("URI=\"init.mp4?{params}\""))
            } else if !line.starts_with('#') && !line.trim().is_empty() {
                format!("{line}?{params}")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_authorized(state: &BridgeState, headers: &HeaderMap) -> bool {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| is_valid_token(state, token))
}

/// The per-run session token (local callers) or any paired device token.
fn is_valid_token(state: &BridgeState, token: &str) -> bool {
    token == state.token.as_ref() || state.pairing.is_device_token(token)
}

fn expand_user_path(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(trimmed));
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        return home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(trimmed));
    }
    PathBuf::from(trimmed)
}

fn paths_match(left: &std::path::Path, right: &std::path::Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn is_too_shallow(path: &std::path::Path) -> bool {
    let mut components = path.components();
    match components.next() {
        Some(std::path::Component::RootDir) => components.next().is_none(),
        Some(std::path::Component::Prefix(_)) => matches!(
            (components.next(), components.next()),
            (None, None) | (Some(std::path::Component::RootDir), None)
        ),
        _ => false,
    }
}

fn is_system_path(path: &std::path::Path) -> bool {
    let lowered = path.to_string_lossy().to_ascii_lowercase();
    const PREFIXES: &[&str] = &[
        "/system",
        "/bin",
        "/sbin",
        "/usr",
        "/etc",
        "/private/var",
        "/windows",
        "/program files",
        "/program files (x86)",
        "c:\\windows",
        "c:\\program files",
    ];
    PREFIXES.iter().any(|prefix| {
        lowered == *prefix
            || lowered.starts_with(&format!("{prefix}/"))
            || lowered.starts_with(&format!("{prefix}\\"))
    })
}

fn prepare_cache_directory(
    raw: &str,
    store_path: &std::path::Path,
    old_dir: &std::path::Path,
) -> Result<PathBuf, String> {
    let path = expand_user_path(raw);
    if !path.is_absolute() {
        return Err("Use an absolute path on the machine running Cubo Core.".into());
    }
    if is_too_shallow(&path) {
        return Err("That location is too close to the system root.".into());
    }
    if is_system_path(&path) {
        return Err("That folder is a system location and cannot be used as the cache.".into());
    }
    if !path.is_dir() {
        return Err("Pick an existing folder on this Core.".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not open that folder: {error}"))?;
    if !canonical.is_dir() {
        return Err("That path is not a folder.".into());
    }

    let store = store_path
        .canonicalize()
        .unwrap_or_else(|_| store_path.to_path_buf());
    if store.starts_with(&canonical) {
        return Err("That folder holds Cubo library data and cannot be wiped as cache.".into());
    }

    let old = old_dir
        .canonicalize()
        .unwrap_or_else(|_| old_dir.to_path_buf());
    if canonical != old && canonical.starts_with(&old) {
        return Err(
            "Pick a folder outside the current cache. A subfolder would be deleted when the old cache is cleared.".into(),
        );
    }
    Ok(canonical)
}

fn unauthorized() -> Response {
    bridge_error(StatusCode::UNAUTHORIZED, "invalid Cubo session".into())
}

fn bridge_error(status: StatusCode, message: String) -> Response {
    if status.is_server_error() {
        tracing::error!(target: "engine", status = %status, error = %message, "request failed");
    }
    (status, Json(json!({ "error": message }))).into_response()
}

/// ffmpeg rewrites `media.m3u8` in place as it appends segments. A poll that
/// hits the file while it is empty or missing is not a server fault.
async fn read_growing_playlist(path: &std::path::Path) -> Result<String, String> {
    let mut last = String::from("playlist not ready");
    for _ in 0..8 {
        match tokio::fs::read_to_string(path).await {
            Ok(content) if content.contains("#EXTINF") => return Ok(content),
            Ok(_) => last = "playlist empty".into(),
            Err(error) => last = error.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err(last)
}

fn proxy_response(upstream: reqwest::Response) -> Response {
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);

    for name in [ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE] {
        if let Some(value) = headers.get(&name) {
            response = response.header(name, value);
        }
    }

    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|error| bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

fn proxy_web_response(upstream: reqwest::Response) -> Response {
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);

    for (name, value) in &headers {
        if !is_hop_by_hop(name.as_str()) {
            response = response.header(name, value);
        }
    }

    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|error| bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

fn is_hop_by_hop(header: &str) -> bool {
    matches!(
        header,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header::ORIGIN;

    #[test]
    fn episode_regex_matches_tv_keys_only() {
        assert!(episode_file_regex(None).is_none());
        assert!(episode_file_regex(Some("movie:550:-:-")).is_none());
        assert!(episode_file_regex(Some("tv:236235:-:-")).is_none());
        let regex = episode_file_regex(Some("tv:236235:2:1")).expect("tv episode");
        assert!(regex.contains("s0*2"));
        assert!(regex.contains("e0*1"));
        assert!(regex.contains("2x0*1"));
        let url = rqbit_add_url(1, std::path::Path::new("/tmp/cache"), Some(4), Some(regex));
        assert!(url.contains("only_files=4"));
        assert!(!url.contains("only_files_regex"));
        let url = rqbit_add_url(
            1,
            std::path::Path::new("/tmp/cache"),
            None,
            episode_file_regex(Some("tv:1:3:9")),
        );
        assert!(url.contains("only_files_regex="));
        assert!(!url.contains("only_files="));
    }

    #[test]
    fn unclaimed_cache_roots_are_wiped() {
        let root = std::env::temp_dir().join(format!("cubo-orphan-{}", Uuid::new_v4()));
        let pack = root.join("season-pack");
        std::fs::create_dir_all(&pack).expect("pack dir");
        std::fs::write(pack.join("s02e01.mkv"), b"keep-me-not").expect("episode");
        std::fs::write(pack.join("s02e02.mkv"), b"sparse-leftover").expect("sibling");
        let other = root.join("other-title.mp4");
        std::fs::write(&other, b"keep").expect("other");

        wipe_unclaimed_roots(
            &root,
            &[pack.join("s02e01.mkv").to_string_lossy().into_owned()],
            &[other.to_string_lossy().into_owned()],
        );
        assert!(!pack.exists());
        assert!(other.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fallback_core_port_is_trusted_for_cors() {
        let ports = allowed_origin_ports(8766);
        assert!(ports.contains(&8765));
        assert!(ports.contains(&4200));
        assert!(ports.contains(&8766));
    }

    #[tokio::test]
    async fn bind_bridges_moves_off_a_busy_preferred_port() {
        let _occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, CORE_PORT))
            .await
            .ok();
        let (port, listeners) = bind_bridges(None).await.expect("fallback bind");
        if _occupied.is_some() || TcpListener::bind((Ipv4Addr::LOCALHOST, CORE_PORT)).await.is_err()
        {
            assert_ne!(port, CORE_PORT);
        }
        assert!(listeners
            .iter()
            .any(|listener| listener.local_addr().is_ok_and(|addr| addr.port() == port)));
    }

    #[test]
    fn default_origins_are_restricted() {
        assert_eq!(CORE_PORT, 8765);
        let origins = allowed_origins(Some("https://cubo.example.com"));
        assert!(origins
            .iter()
            .any(|origin| origin == "https://cubo.example.com"));
        assert!(!origins.iter().any(|origin| origin == "*"));
    }

    #[test]
    fn release_hash_follows_the_opensubtitles_spec() {
        // 128 KiB file of 0xFF bytes: size + 2 chunks * 8192 words * u64::MAX.
        let chunk = vec![0xFF_u8; RELEASE_HASH_CHUNK as usize];
        let size = (RELEASE_HASH_CHUNK * 2) as u64;
        let hash = combine_release_hash(size, &chunk, &chunk).expect("hash");
        assert_eq!(hash, size.wrapping_add(16_384u64.wrapping_mul(u64::MAX)));

        // Distinct head/tail content must both contribute.
        let mut other = chunk.clone();
        other[0] = 0x01;
        let mixed = combine_release_hash(size, &chunk, &other).expect("hash");
        assert_ne!(mixed, hash);

        // Short reads are rejected rather than hashed incorrectly.
        assert!(combine_release_hash(size, &chunk[..8], &chunk).is_err());

        // Hex form is the fixed-width lowercase OpenSubtitles expects.
        let hex = format!("{hash:016x}");
        assert_eq!(hex.len(), 16);
        assert!(hex
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[tokio::test]
    async fn bridge_is_discoverable_and_requires_its_session_token() {
        let web_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind test web app");
        let web_port = web_listener.local_addr().expect("test web address").port();
        tokio::spawn(async move {
            axum::serve(
                web_listener,
                Router::new().route(
                    "/",
                    get(|| async { "<html><body>shared Cubo frontend</body></html>" }),
                ),
            )
            .await
            .expect("serve test web app");
        });
        let bridge_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind test Cubo bridge");
        let port = bridge_listener
            .local_addr()
            .expect("test bridge address")
            .port();
        let test_dir = std::env::temp_dir().join(format!("cubo-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&test_dir).expect("create test directory");
        let store = CoreStore::load(test_dir.join("state.json"))
            .await
            .expect("load test store");
        let transcode_dir = test_dir.join("transcode");
        let pairing = Arc::new(PairingManager::load(&test_dir).expect("load test pairing manager"));
        let pairing_dir = test_dir.clone();
        let state = BridgeState {
            rqbit_port: 1,
            token: "test-session-token".into(),
            client: reqwest::Client::new(),
            web_origin: Some(format!("http://127.0.0.1:{web_port}").into()),
            allowed_hosts: Arc::new(vec!["kenobi.test".into()]),
            bridge_port: port,
            download_dir: Arc::new(RwLock::new(test_dir)),
            playback_last_ms: Arc::new(AtomicU64::new(0)),
            cache_swap: Arc::new(Mutex::new(())),
            disk_pressure: Arc::new(AtomicBool::new(false)),
            store,
            transcode: Arc::new(TranscodeManager::new(transcode_dir)),
            subtitle_matches: Arc::new(Mutex::new(HashMap::new())),
            pairing,
            updater: Arc::new(UpdateManager::new()),
        };
        tokio::spawn(async move {
            let service = bridge_router(state).into_make_service_with_connect_info::<SocketAddr>();
            axum::serve(bridge_listener, service)
                .await
                .expect("serve test Cubo bridge");
        });

        let client = reqwest::Client::new();
        let base_url = format!("http://127.0.0.1:{port}");

        let web_app = client
            .get(&base_url)
            .send()
            .await
            .expect("proxied web response");
        assert_eq!(web_app.status(), StatusCode::OK);
        assert!(web_app
            .text()
            .await
            .expect("proxied web body")
            .contains("shared Cubo frontend"));

        let preflight = client
            .request(Method::OPTIONS, format!("{base_url}/v1/torrents"))
            .header(ORIGIN, "http://localhost:4200")
            .header("access-control-request-method", "POST")
            .header(
                "access-control-request-headers",
                "authorization,content-type",
            )
            .header("access-control-request-private-network", "true")
            .send()
            .await
            .expect("preflight response");
        assert_eq!(preflight.status(), StatusCode::OK);
        assert_eq!(
            preflight.headers().get("access-control-allow-origin"),
            Some(&HeaderValue::from_static("http://localhost:4200"))
        );
        assert_eq!(
            preflight
                .headers()
                .get("access-control-allow-private-network"),
            Some(&HeaderValue::from_static("true"))
        );

        let health = client
            .get(format!("{base_url}/v1/health"))
            .header(ORIGIN, "http://localhost:4200")
            .send()
            .await
            .expect("health response");
        assert_eq!(health.status(), StatusCode::OK);
        // Loopback origins on unrelated ports (some other local app) are NOT
        // trusted — "it runs on my machine" is not an identity.
        let stranger_local = client
            .get(format!("{base_url}/v1/health"))
            .header(ORIGIN, "http://localhost:5500")
            .send()
            .await
            .expect("unrelated local origin response");
        assert!(stranger_local
            .headers()
            .get("access-control-allow-origin")
            .is_none());
        let health: serde_json::Value = health.json().await.expect("health JSON");
        assert_eq!(health["name"], "cubo-core");
        // The test client connects over loopback, so it is trusted with the
        // session token either way; pairingRequired only ever turns true for
        // remote callers, and only while the pairing flow is enabled.
        assert_eq!(health["pairingRequired"], false);
        assert!(health["sessionToken"]
            .as_str()
            .is_some_and(|token| !token.is_empty()));

        if crate::pairing::PAIRING_ENABLED {
            // Pairing: a wrong code is rejected, a current authenticator code
            // mints a device token that authorizes API calls.
            let bad_pair = client
                .post(format!("{base_url}/v1/pair"))
                .json(&json!({ "code": "000000" }))
                .send()
                .await
                .expect("pair response");
            assert!(
                bad_pair.status() == StatusCode::UNAUTHORIZED
                    || bad_pair.status() == StatusCode::TOO_MANY_REQUESTS
            );

            let (code, _) =
                crate::pairing::current_code_for_dir(&pairing_dir).expect("pairing code");
            let paired = client
                .post(format!("{base_url}/v1/pair"))
                .json(&json!({ "code": code, "deviceName": "test laptop" }))
                .send()
                .await
                .expect("pair response");
            assert_eq!(paired.status(), StatusCode::OK);
            let paired: serde_json::Value = paired.json().await.expect("pair JSON");
            let device_token = paired["token"].as_str().expect("device token");
            let library = client
                .get(format!("{base_url}/v1/library"))
                .header(AUTHORIZATION, format!("Bearer {device_token}"))
                .send()
                .await
                .expect("library via device token");
            assert_eq!(library.status(), StatusCode::OK);
        } else {
            // While disabled, the pair endpoint must not exist as far as
            // callers can tell — even a valid code is turned away.
            let (code, _) =
                crate::pairing::current_code_for_dir(&pairing_dir).expect("pairing code");
            let refused = client
                .post(format!("{base_url}/v1/pair"))
                .json(&json!({ "code": code }))
                .send()
                .await
                .expect("pair response");
            assert_eq!(refused.status(), StatusCode::NOT_FOUND);
        }

        let unauthorized = client
            .post(format!("{base_url}/v1/torrents"))
            .header(ORIGIN, "http://localhost:4200")
            .body("magnet:?xt=urn:btih:test")
            .send()
            .await
            .expect("unauthorized response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let untrusted_origin = client
            .get(format!("{base_url}/v1/health"))
            .header(ORIGIN, "https://example.com")
            .send()
            .await
            .expect("untrusted origin response");
        assert!(untrusted_origin
            .headers()
            .get("access-control-allow-origin")
            .is_none());
    }

    #[test]
    fn cache_paths_expand_home_and_reject_roots() {
        if let Some(home) = super::home_dir() {
            assert_eq!(
                super::expand_user_path("~/cubo-cache"),
                home.join("cubo-cache")
            );
        }
        assert!(super::is_too_shallow(std::path::Path::new("/")));
        assert!(super::is_system_path(std::path::Path::new("/usr/bin")));
        assert!(!super::is_system_path(std::path::Path::new(
            "/Users/someone/Movies/cubo"
        )));
    }

    #[test]
    fn cache_directory_refuses_a_subfolder_of_the_current_cache() {
        let root = std::env::temp_dir().join(format!("cubo-cache-test-{}", Uuid::new_v4()));
        let current = root.join("current");
        let nested = current.join("nested");
        let store = root.join("cubo-state.json");
        std::fs::create_dir_all(&nested).expect("create nested cache");
        std::fs::write(&store, "{}").expect("write store");
        let error =
            super::prepare_cache_directory(nested.to_str().expect("utf8 path"), &store, &current)
                .expect_err("nested cache must be refused");
        assert!(error.contains("subfolder"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
