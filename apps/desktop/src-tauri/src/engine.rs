use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body, Bytes};
use axum::extract::ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Path, Query, State};
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
use tokio::sync::OnceCell;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;
use tower_http::cors::{AllowOrigin, CorsLayer};
use uuid::Uuid;

use crate::store::{CoreStore, PlaybackUpdate, WatchLaterUpdate};

const CORE_PORT: u16 = 8765;
const WEB_PROXY_BODY_LIMIT: usize = 10 * 1024 * 1024;
/// Canonical web deployment. Release builds proxy browser visitors here and
/// trust its origin. Set to "" to disable the browser gateway entirely.
const WEB_DEPLOYMENT_URL: &str = "https://app.cubo.spheceo.com";
// The bundled desktop webview reaches Core from tauri://localhost (macOS) or
// http://tauri.localhost (Windows); the Vite dev server uses the loopback pair.
const DEFAULT_ALLOWED_ORIGINS: [&str; 4] = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "tauri://localhost",
    "http://tauri.localhost",
];

pub struct Engine {
    bridge_port: u16,
    bridge_addresses: Vec<SocketAddr>,
    // Held for the app's lifetime so the session and its DHT tasks stay alive.
    _session: Arc<Session>,
}

#[derive(Clone)]
struct BridgeState {
    rqbit_port: u16,
    token: Arc<str>,
    client: reqwest::Client,
    web_origin: Option<Arc<str>>,
    download_dir: Arc<PathBuf>,
    store: CoreStore,
}

#[derive(Deserialize)]
struct StreamQuery {
    token: String,
}

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
            let store = CoreStore::load(state_path).await?;
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

            tauri::async_runtime::spawn(async move {
                if let Err(error) = http_api.make_http_api_and_run(rqbit_listener, None).await {
                    eprintln!("rqbit HTTP API exited: {error:#}");
                }
            });

            let bridge_listeners = bind_bridges().await?;
            let bridge_addresses = bridge_listeners
                .iter()
                .filter_map(|listener| listener.local_addr().ok())
                .collect::<Vec<_>>();
            let state = BridgeState {
                rqbit_port,
                token: Uuid::new_v4().simple().to_string().into(),
                client: reqwest::Client::new(),
                web_origin: resolve_web_origin()?,
                download_dir: Arc::new(download_dir),
                store,
            };
            let router = bridge_router(state.clone());

            let maintenance_state = state.clone();
            tauri::async_runtime::spawn(async move {
                cache_maintenance_loop(maintenance_state).await;
            });

            for listener in bridge_listeners {
                let listener_router = router.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = axum::serve(listener, listener_router).await {
                        eprintln!("Cubo bridge exited: {error:#}");
                    }
                });
            }

            Ok::<Engine, String>(Engine {
                bridge_port: CORE_PORT,
                bridge_addresses,
                _session: session,
            })
        })
        .await?;

    Ok(engine.bridge_port)
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

async fn bind_bridges() -> Result<Vec<TcpListener>, String> {
    let mut addresses = vec![
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ];
    if let Some(address) = detect_tailscale_ipv4() {
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
                eprintln!(
                    "Cubo Core could not bind optional address {address}:{CORE_PORT}: {error}"
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

fn is_loopback_origin(origin: &HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Ok(url) = reqwest::Url::parse(origin) else {
        return false;
    };
    matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    )
}

fn bridge_router(state: BridgeState) -> Router {
    let allowed_origins = allowed_origins(state.web_origin.as_deref());
    let allow_origin = AllowOrigin::predicate(move |origin: &HeaderValue, _| {
        is_loopback_origin(origin) || allowed_origins.iter().any(|allowed| allowed == origin)
    });
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
        .expose_headers([ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE]);

    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/torrents", post(add_torrent))
        .route("/v1/torrents/{id}/stats", get(torrent_stats))
        .route("/v1/torrents/{id}/stream/{file_index}", get(stream_torrent))
        .route("/v1/library", get(library_snapshot))
        .route("/v1/library/progress", post(record_playback))
        .route("/v1/library/watch-later", post(update_watch_later))
        .route("/v1/cache", get(cache_status).delete(clear_cache))
        .route("/v1/cache/settings", put(update_cache_settings))
        .route("/v1/cache/{id}", axum::routing::delete(delete_cache_item))
        .fallback(web_fallback)
        .with_state(state)
        .layer(cors)
        .layer(middleware::from_fn(add_private_network_header))
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
        "http://127.0.0.1:3000"
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

async fn add_private_network_header(request: axum::extract::Request, next: Next) -> Response {
    let wants_private_network = request
        .headers()
        .get("access-control-request-private-network")
        .is_some_and(|value| value == "true");
    let mut response = next.run(request).await;
    if wants_private_network {
        response.headers_mut().insert(
            HeaderName::from_static("access-control-allow-private-network"),
            HeaderValue::from_static("true"),
        );
    }
    response
}

async fn health(State(state): State<BridgeState>) -> impl IntoResponse {
    Json(json!({
        "name": "cubo-core",
        "version": env!("CARGO_PKG_VERSION"),
        "engine": "rqbit",
        "engineVersion": librqbit::version(),
        "sessionToken": state.token,
        "webUrl": state.web_origin,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheSettingsUpdate {
    max_bytes: u64,
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
    match state.store.record_playback(update).await {
        Ok(snapshot) => Json(snapshot).into_response(),
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
            tauri::async_runtime::spawn(async move {
                if let Err(error) = enforce_cache_limit(&maintenance).await {
                    eprintln!("Cubo cache maintenance failed: {error}");
                }
            });
            Json(snapshot.cache).into_response()
        }
        Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn cache_status(State(state): State<BridgeState>, headers: HeaderMap) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    let snapshot = state.store.snapshot().await;
    match cache_size(state.download_dir.clone()).await {
        Ok(used_bytes) => Json(json!({
            "usedBytes": used_bytes,
            "maxBytes": snapshot.cache.max_bytes,
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
    let response = state
        .client
        .post(format!(
            "http://127.0.0.1:{}/torrents/{}/delete",
            state.rqbit_port,
            urlencoding::encode(&id)
        ))
        .send()
        .await;

    match response {
        Ok(response) if response.status().is_success() => {
            if let Err(error) = state.store.remove_cache_entry(&id).await {
                return bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error);
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(response) => bridge_error(response.status(), "Could not remove cached video".into()),
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error.to_string()),
    }
}

async fn clear_cache(State(state): State<BridgeState>, headers: HeaderMap) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized();
    }
    match delete_all_torrents(&state).await {
        Ok(()) => match state.store.clear_cache_entries().await {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(error) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, error),
        },
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error),
    }
}

async fn cache_maintenance_loop(state: BridgeState) {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        if let Err(error) = enforce_cache_limit(&state).await {
            eprintln!("Cubo cache maintenance failed: {error}");
        }
    }
}

async fn enforce_cache_limit(state: &BridgeState) -> Result<(), String> {
    let snapshot = state.store.snapshot().await;
    let mut used_bytes = cache_size(state.download_dir.clone()).await?;
    if used_bytes <= snapshot.cache.max_bytes {
        return Ok(());
    }

    let mut entries = snapshot.cache_entries;
    entries.sort_by_key(|entry| entry.last_accessed_at);
    for entry in entries {
        let id = entry
            .torrent_id
            .map(|value| value.to_string())
            .unwrap_or_else(|| entry.info_hash.clone());
        let response = state
            .client
            .post(format!(
                "http://127.0.0.1:{}/torrents/{}/delete",
                state.rqbit_port,
                urlencoding::encode(&id)
            ))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response.status().is_success() {
            state.store.remove_cache_entry(&id).await?;
        }
        used_bytes = cache_size(state.download_dir.clone()).await?;
        if used_bytes <= snapshot.cache.max_bytes {
            break;
        }
    }
    Ok(())
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
    for torrent in list.torrents {
        let id = torrent
            .id
            .map(|value| value.to_string())
            .unwrap_or(torrent.info_hash);
        let response = state
            .client
            .post(format!(
                "http://127.0.0.1:{}/torrents/{}/delete",
                state.rqbit_port,
                urlencoding::encode(&id)
            ))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("rqbit could not delete torrent {id}"));
        }
    }
    Ok(())
}

async fn cache_size(download_dir: Arc<PathBuf>) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || directory_size(download_dir.as_path()))
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
            "http://127.0.0.1:{}/torrents?overwrite=true",
            state.rqbit_port
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
                    if let Err(error) = state
                        .store
                        .touch_cache(torrent_id, info_hash, media_key, title)
                        .await
                    {
                        eprintln!("Could not update Cubo cache index: {error}");
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
    if query.token != state.token.as_ref() {
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

fn is_authorized(state: &BridgeState, headers: &HeaderMap) -> bool {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token == state.token.as_ref())
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

    #[tokio::test]
    async fn bridge_is_discoverable_and_requires_its_session_token() {
        let web_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind test web app");
        let web_port = web_listener.local_addr().expect("test web address").port();
        tauri::async_runtime::spawn(async move {
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
        let state = BridgeState {
            rqbit_port: 1,
            token: "test-session-token".into(),
            client: reqwest::Client::new(),
            web_origin: Some(format!("http://127.0.0.1:{web_port}").into()),
            download_dir: Arc::new(test_dir),
            store,
        };
        tauri::async_runtime::spawn(async move {
            axum::serve(bridge_listener, bridge_router(state))
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
            .header(ORIGIN, "http://localhost:3000")
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
            Some(&HeaderValue::from_static("http://localhost:3000"))
        );
        assert_eq!(
            preflight
                .headers()
                .get("access-control-allow-private-network"),
            Some(&HeaderValue::from_static("true"))
        );

        let health = client
            .get(format!("{base_url}/v1/health"))
            .header(ORIGIN, "http://localhost:3000")
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
        let health: serde_json::Value = health.json().await.expect("health JSON");
        assert_eq!(health["name"], "cubo-core");
        assert!(health["sessionToken"]
            .as_str()
            .is_some_and(|token| !token.is_empty()));

        let unauthorized = client
            .post(format!("{base_url}/v1/torrents"))
            .header(ORIGIN, "http://localhost:3000")
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
}
