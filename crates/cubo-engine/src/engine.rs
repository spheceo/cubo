use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
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

use crate::pairing::{PairAttempt, PairingManager};
use crate::paths::home_dir;
use crate::store::{self, CoreStore, PlaybackUpdate, WatchLaterUpdate};
use crate::system;
use crate::transcode::TranscodeManager;

const CORE_PORT: u16 = 8765;
const WEB_PROXY_BODY_LIMIT: usize = 10 * 1024 * 1024;
/// Canonical web deployment. Release builds proxy browser visitors here and
/// trust its origin. Set to "" to disable the browser gateway entirely.
const WEB_DEPLOYMENT_URL: &str = "https://app.cubo.spheceo.com";
// The bundled desktop webview reaches Core from tauri://localhost (macOS) or
// http://tauri.localhost (Windows); the Vite dev server uses the loopback pair.
const DEFAULT_ALLOWED_ORIGINS: [&str; 4] = [
    "http://localhost:4200",
    "http://127.0.0.1:4200",
    "tauri://localhost",
    "http://tauri.localhost",
];
/// Ports a loopback or own-hostname origin may use: Core itself (pages it
/// proxies), the web dev server, and the Tauri dev server. Any other local
/// port is some unrelated app and gets no CORS access.
const ALLOWED_ORIGIN_PORTS: [u16; 3] = [CORE_PORT, 4200, 1420];

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
    /// Cubo's own ports (see ALLOWED_ORIGIN_PORTS).
    allowed_hosts: Arc<Vec<String>>,
    download_dir: Arc<RwLock<PathBuf>>,
    /// Last time a viewer was clearly pulling video (progress, buffer poll,
    /// remux segment). Playlist polls do not count — those continue while paused.
    playback_last_ms: Arc<AtomicU64>,
    cache_swap: Arc<Mutex<()>>,
    store: CoreStore,
    transcode: Arc<TranscodeManager>,
    /// Computed OpenSubtitles release matches, keyed by `{torrent}:{file}`.
    /// Each one costs two ranged reads through rqbit (the tail can pull
    /// pieces from peers), so results are remembered for the session.
    subtitle_matches: Arc<Mutex<HashMap<String, SubtitleMatchInfo>>>,
    /// Authenticator-style pairing: verifies offline codes and remembers
    /// device tokens issued to remote (non-loopback) clients.
    pairing: Arc<PairingManager>,
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
}

/// Progress ticks every 10s while playing; this window covers a missed tick
/// plus the pause report so a swap is refused until the viewer actually stops.
const PLAYBACK_GUARD_MS: u64 = 20_000;

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
            // this embedder's store: the desktop app passes its Tauri
            // app-data folder here, while `cubo pair` (a separate process)
            // reads paths::data_dir() — both must see one secret, or codes
            // printed in the terminal would never match a desktop Core.
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
            let bridge_listeners = bind_bridges(tailscale_address).await?;
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
                download_dir: download_dir.clone(),
                playback_last_ms: Arc::new(AtomicU64::new(0)),
                cache_swap: Arc::new(Mutex::new(())),
                store,
                transcode: Arc::new(TranscodeManager::new(transcode_dir)),
                subtitle_matches: Arc::new(Mutex::new(HashMap::new())),
                pairing,
            };
            let router = bridge_router(state.clone());

            let maintenance_state = state.clone();
            tokio::spawn(async move {
                cache_maintenance_loop(maintenance_state).await;
            });

            tracing::info!(
                target: "engine",
                bridge_port = CORE_PORT,
                rqbit_port,
                addresses = ?bridge_addresses,
                "Cubo engine started"
            );

            for listener in bridge_listeners {
                let listener_router = router.clone();
                tokio::spawn(async move {
                    // Connect info lets /v1/health tell loopback callers
                    // (handed the session token) from remote ones (must pair).
                    let service = listener_router
                        .into_make_service_with_connect_info::<SocketAddr>();
                    if let Err(error) = axum::serve(listener, service).await {
                        tracing::error!(target: "engine", error = %error, "Cubo bridge exited");
                    }
                });
            }

            Ok::<Engine, String>(Engine {
                bridge_port: CORE_PORT,
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

async fn bind_bridges(tailscale_address: Option<IpAddr>) -> Result<Vec<TcpListener>, String> {
    let mut addresses = vec![
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ];
    if let Some(address) = tailscale_address {
        if !address.is_loopback() && !addresses.contains(&address) {
            addresses.push(address);
        }
    }

    let mut listeners = Vec::new();
    for address in addresses {
        match TcpListener::bind((address, CORE_PORT)).await {
            Ok(listener) => listeners.push(listener),
            Err(error) if address == IpAddr::V4(Ipv4Addr::LOCALHOST) => {
                return Err(format!(
                    "Cubo Core could not bind {address}:{CORE_PORT}: {error}"
                ));
            }
            Err(error) => {
                tracing::warn!(
                    target: "engine",
                    %address, %error,
                    "Cubo Core could not bind optional address"
                );
            }
        }
    }

    Ok(listeners)
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
/// (dev servers, the Tauri webview, the web deployment) pass as-is; loopback
/// and own-hostname/Tailscale origins pass only on Cubo's own ports, so an
/// unrelated local app on some other port is not silently trusted.
struct OriginPolicy {
    allowed_origins: Arc<Vec<HeaderValue>>,
    allowed_hosts: Arc<Vec<String>>,
}

impl OriginPolicy {
    fn allows(&self, origin: &HeaderValue) -> bool {
        if self.allowed_origins.iter().any(|allowed| allowed == origin) {
            return true;
        }
        let Some((host, port)) = origin_host_port(origin) else {
            return false;
        };
        if !port.is_some_and(|port| ALLOWED_ORIGIN_PORTS.contains(&port)) {
            return false;
        }
        is_loopback_host(&host) || self.allowed_hosts.contains(&host)
    }
}

/// Hostnames and addresses pages can use to reach this machine over the
/// network: the system hostname and the detected Tailscale IPv4.
fn local_machine_hosts(tailscale_address: Option<IpAddr>) -> Vec<String> {
    let mut hosts = Vec::new();
    for executable in ["hostname", "/bin/hostname"] {
        if let Ok(output) = Command::new(executable).output() {
            if output.status.success() {
                let name = String::from_utf8_lossy(&output.stdout).trim().to_ascii_lowercase();
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

/// The deployment Core proxies browser-hosted pages to. Debug builds use the
/// local Vite server; release builds use WEB_DEPLOYMENT_URL. The desktop app
/// itself bundles the UI, so only the "open Core in a browser" flow needs this.
fn resolve_web_origin() -> Result<Option<Arc<str>>, String> {
    let origin = if cfg!(debug_assertions) {
        "http://127.0.0.1:4200"
    } else {
        WEB_DEPLOYMENT_URL
    };
    let origin = origin.trim().trim_end_matches('/');
    if origin.is_empty() {
        return Ok(None);
    }

    let parsed = reqwest::Url::parse(origin)
        .map_err(|error| format!("invalid WEB_DEPLOYMENT_URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("WEB_DEPLOYMENT_URL must use HTTP or HTTPS".into());
    }

    Ok(Some(origin.to_owned().into()))
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
        return bridge_error(StatusCode::NOT_FOUND, "Pairing is not enabled on this Core.".into());
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
    let snapshot =
        tokio::task::spawn_blocking(move || system::snapshot(&download_dir)).await;
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
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
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
    match cache_size(download_dir.clone()).await {
        Ok(used_bytes) => Json(json!({
            "usedBytes": used_bytes,
            "maxBytes": snapshot.cache.max_bytes,
            "directory": download_dir.to_string_lossy(),
            "itemCount": snapshot.cache_entries.len(),
            "entries": snapshot.cache_entries,
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
        tokio::time::sleep(Duration::from_secs(60)).await;
        if let Err(error) = enforce_cache_limit(&state).await {
            tracing::warn!(target: "engine", error = %error, "cache maintenance failed");
        }
    }
}

async fn enforce_cache_limit(state: &BridgeState) -> Result<(), String> {
    let snapshot = state.store.snapshot().await;
    let download_dir = state.current_download_dir().await;
    let mut used_bytes = cache_size(download_dir.clone()).await?;
    if used_bytes <= snapshot.cache.max_bytes {
        return Ok(());
    }

    let mut entries = snapshot.cache_entries;
    entries.sort_by_key(|entry| entry.last_accessed_at);
    for entry in entries {
        if used_bytes <= snapshot.cache.max_bytes {
            return Ok(());
        }
        let id = entry
            .torrent_id
            .map(|value| value.to_string())
            .unwrap_or_else(|| entry.info_hash.clone());
        // Delete through rqbit when it still knows the torrent, and always
        // remove the recorded files — after a restart only the files exist.
        if rqbit_delete(state, &id).await.is_ok() {
            // Charge the entry's own files against the running total instead
            // of re-walking the whole tree after every deletion.
            let freed = entry_files_size(&entry.files).await;
            remove_entry_files(&download_dir, &entry.files).await;
            state.store.remove_cache_entry(&id).await?;
            used_bytes = used_bytes.saturating_sub(freed);
        }
    }

    // Still over the limit: whatever remains is untracked (downloaded before
    // file paths were recorded). Reclaim the oldest items, sparing anything
    // touched in the last 10 minutes — that could be an active stream.
    let max_bytes = snapshot.cache.max_bytes;
    tokio::task::spawn_blocking(move || reclaim_untracked(&download_dir, max_bytes))
        .await
        .map_err(|error| error.to_string())?
}

fn reclaim_untracked(dir: &std::path::Path, max_bytes: u64) -> Result<(), String> {
    const ACTIVE_GRACE: std::time::Duration = std::time::Duration::from_secs(600);

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

    for (path, modified) in items {
        if used_bytes <= max_bytes {
            return Ok(());
        }
        if modified.elapsed().unwrap_or_default() < ACTIVE_GRACE {
            continue;
        }
        // Track what each removal frees so the tree is walked once, not once
        // per deletion.
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

async fn cache_size(download_dir: PathBuf) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || directory_size(&download_dir))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
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

/// Everything outside /v1/* lands here: websocket upgrades (Vite HMR in dev)
/// go to the socket proxy, normal requests to the web proxy, and when no web
/// deployment is configured Core serves a small status page instead.
async fn web_fallback(
    State(state): State<BridgeState>,
    request: axum::extract::Request,
) -> Response {
    let Some(web_origin) = state.web_origin.clone() else {
        return core_status_page();
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

fn core_status_page() -> Response {
    let body = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>cubo core</title>\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head>\
         <body style=\"margin:0;min-height:100vh;display:grid;place-items:center;background:#08080a;color:#f5f5f3;\
         font-family:ui-sans-serif,system-ui,sans-serif;text-align:center\">\
         <p><strong>cubo core</strong> v{} is running on this device.<br>\
         <span style=\"color:#a3a3ab;font-size:0.9em\">This build has no web deployment configured.</span></p>\
         </body></html>",
        env!("CARGO_PKG_VERSION"),
    );
    ([(CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
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

    match upstream.send().await {
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

async fn add_torrent(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
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

    match state
        .client
        .post(format!(
            "http://127.0.0.1:{}/torrents?overwrite=true&output_folder={}",
            state.rqbit_port,
            urlencoding::encode(&state.current_download_dir().await.to_string_lossy())
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
                                    .filter_map(|file| {
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
                            files
                                .iter()
                                .enumerate()
                                .max_by_key(|(_, file)| {
                                    file.get("length").and_then(serde_json::Value::as_u64)
                                })
                                .filter(|(_, file)| {
                                    file.get("name")
                                        .and_then(serde_json::Value::as_str)
                                        .is_some_and(|name| {
                                            name.to_ascii_lowercase().ends_with(".mkv")
                                        })
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
    // so a directory swap cannot yank the files out from under a start.
    state.mark_playback();

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
    let tail = read_stream_range(
        client,
        stream_url,
        size - RELEASE_HASH_CHUNK,
        size - 1,
    )
    .await?;
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
        if !state.transcode.job_usable(&key, start).await {
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
                .ensure_job(&key, &input_url, &probe, start)
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

        return match tokio::fs::read_to_string(job_dir.join("media.m3u8")).await {
            Ok(content) => {
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
                response
            }
            Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
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
                line.replace(
                    "URI=\"init.mp4\"",
                    &format!("URI=\"init.mp4?{params}\""),
                )
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
        return Err(
            "That folder holds Cubo library data and cannot be wiped as cache.".into(),
        );
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
    (status, Json(json!({ "error": message }))).into_response()
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
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
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
        let pairing =
            Arc::new(PairingManager::load(&test_dir).expect("load test pairing manager"));
        let pairing_dir = test_dir.clone();
        let state = BridgeState {
            rqbit_port: 1,
            token: "test-session-token".into(),
            client: reqwest::Client::new(),
            web_origin: Some(format!("http://127.0.0.1:{web_port}").into()),
            allowed_hosts: Arc::new(vec!["kenobi.test".into()]),
            download_dir: Arc::new(RwLock::new(test_dir)),
            playback_last_ms: Arc::new(AtomicU64::new(0)),
            cache_swap: Arc::new(Mutex::new(())),
            store,
            transcode: Arc::new(TranscodeManager::new(transcode_dir)),
            subtitle_matches: Arc::new(Mutex::new(HashMap::new())),
            pairing,
        };
        tokio::spawn(async move {
            let service =
                bridge_router(state).into_make_service_with_connect_info::<SocketAddr>();
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
        let desktop_dev = client
            .get(format!("{base_url}/v1/health"))
            .header(ORIGIN, "http://localhost:1420")
            .send()
            .await
            .expect("desktop loopback origin response");
        assert_eq!(
            desktop_dev.headers().get("access-control-allow-origin"),
            Some(&HeaderValue::from_static("http://localhost:1420"))
        );
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
            assert_eq!(super::expand_user_path("~/cubo-cache"), home.join("cubo-cache"));
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
        let error = super::prepare_cache_directory(
            nested.to_str().expect("utf8 path"),
            &store,
            &current,
        )
        .expect_err("nested cache must be refused");
        assert!(error.contains("subfolder"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
