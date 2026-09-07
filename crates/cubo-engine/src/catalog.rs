//! Allowlisted catalog and subtitle proxies. TMDB goes through Cubo's
//! Cloudflare Worker (the key never lives in this binary). Torrentio and
//! OpenSubtitles have no secret and are called directly.

use std::time::Duration;

use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use reqwest::Client;

/// Default catalog Worker. Override with `CUBO_CATALOG_URL`. Bring-your-own
/// TMDB key with `TMDB_API_KEY` (skips the Worker).
pub const DEFAULT_CATALOG_URL: &str = "https://cubo-catalog.sphe-g-personal.workers.dev";

const TMDB_BASE: &str = "https://api.themoviedb.org/3";
const TORRENTIO_BASE: &str = "https://torrentio.strem.fun";
const SUBTITLES_BASE: &str = "https://opensubtitles-v3.strem.io";

pub async fn proxy(client: &Client, request: axum::extract::Request) -> Response {
    let uri = request.uri();
    let path = uri.path();
    let query = uri.query().unwrap_or("");

    if let Some(rest) = path.strip_prefix("/api/tmdb") {
        return tmdb(client, rest.trim_start_matches('/'), query).await;
    }
    if let Some(rest) = path.strip_prefix("/api/torrentio") {
        return torrentio(client, rest.trim_start_matches('/'), query).await;
    }
    if let Some(rest) = path.strip_prefix("/api/subtitles") {
        return subtitles(client, rest.trim_start_matches('/'), query).await;
    }
    if path == "/api/subtitle-file" {
        return subtitle_file(client, query).await;
    }
    (StatusCode::NOT_FOUND, "Unknown API route").into_response()
}

pub fn catalog_base() -> String {
    std::env::var("CUBO_CATALOG_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CATALOG_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

async fn tmdb(client: &Client, path: &str, query: &str) -> Response {
    if !tmdb_allowed(path) {
        return json_error(StatusCode::NOT_FOUND, "Unknown catalog endpoint");
    }
    if let Ok(key) = std::env::var("TMDB_API_KEY") {
        if !key.trim().is_empty() {
            let mut params = query_params(query);
            params.insert("api_key".into(), key);
            let encoded = params
                .iter()
                .map(|(name, value)| {
                    format!("{}={}", urlencoding::encode(name), urlencoding::encode(value))
                })
                .collect::<Vec<_>>()
                .join("&");
            let url = format!("{TMDB_BASE}/{path}?{encoded}");
            return forward_json(client, &url, Duration::from_secs(10), 3600).await;
        }
    }
    let url = if query.is_empty() {
        format!("{}/{path}", catalog_base())
    } else {
        format!("{}/{path}?{query}", catalog_base())
    };
    forward_json(client, &url, Duration::from_secs(10), 3600).await
}

async fn torrentio(client: &Client, path: &str, query: &str) -> Response {
    if !torrentio_allowed(path) {
        return json_error(StatusCode::NOT_FOUND, "Unknown stream endpoint");
    }
    let url = if query.is_empty() {
        format!("{TORRENTIO_BASE}/{path}")
    } else {
        format!("{TORRENTIO_BASE}/{path}?{query}")
    };
    forward_json(client, &url, Duration::from_secs(20), 300).await
}

async fn subtitles(client: &Client, path: &str, query: &str) -> Response {
    if !subtitles_allowed(path) {
        return json_error(StatusCode::NOT_FOUND, "Unknown subtitle endpoint");
    }
    let url = if query.is_empty() {
        format!("{SUBTITLES_BASE}/{path}")
    } else {
        format!("{SUBTITLES_BASE}/{path}?{query}")
    };
    forward_json(client, &url, Duration::from_secs(20), 21_600).await
}

async fn subtitle_file(client: &Client, query: &str) -> Response {
    let params = query_params(query);
    let Some(value) = params.get("url") else {
        return (StatusCode::BAD_REQUEST, "Missing subtitle URL").into_response();
    };
    let Ok(source) = reqwest::Url::parse(value) else {
        return (StatusCode::BAD_REQUEST, "Invalid subtitle URL").into_response();
    };
    if source.scheme() != "https"
        || !source
            .host_str()
            .is_some_and(|host| host.ends_with(".strem.io"))
    {
        return (StatusCode::BAD_REQUEST, "Unsupported subtitle host").into_response();
    }
    match client.get(source).timeout(Duration::from_secs(20)).send().await {
        Ok(upstream) if upstream.status().is_success() => match upstream.text().await {
            Ok(body) => {
                let vtt = to_web_vtt(&body);
                (
                    [
                        (
                            CONTENT_TYPE,
                            HeaderValue::from_static("text/vtt; charset=utf-8"),
                        ),
                        (
                            axum::http::header::CACHE_CONTROL,
                            HeaderValue::from_static("public, max-age=86400"),
                        ),
                    ],
                    vtt,
                )
                    .into_response()
            }
            Err(_) => (StatusCode::BAD_GATEWAY, "Subtitle unavailable").into_response(),
        },
        Ok(upstream) => (
            StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            "Subtitle unavailable",
        )
            .into_response(),
        Err(_) => (StatusCode::BAD_GATEWAY, "Subtitle unavailable").into_response(),
    }
}

async fn forward_json(client: &Client, url: &str, timeout: Duration, cache_seconds: u32) -> Response {
    match client.get(url).timeout(timeout).send().await {
        Ok(upstream) => {
            let status =
                StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            match upstream.bytes().await {
                Ok(body) => {
                    let cache = format!(
                        "public, s-maxage={cache_seconds}, stale-while-revalidate={}",
                        cache_seconds.saturating_mul(2)
                    );
                    (
                        status,
                        [
                            (
                                CONTENT_TYPE,
                                HeaderValue::from_static("application/json; charset=utf-8"),
                            ),
                            (
                                axum::http::header::CACHE_CONTROL,
                                HeaderValue::from_str(&cache)
                                    .unwrap_or(HeaderValue::from_static("public")),
                            ),
                        ],
                        body,
                    )
                        .into_response()
                }
                Err(_) => json_error(StatusCode::BAD_GATEWAY, "Upstream error"),
            }
        }
        Err(_) => json_error(StatusCode::BAD_GATEWAY, "Upstream error"),
    }
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(
            CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        )],
        format!(r#"{{"error":"{message}"}}"#),
    )
        .into_response()
}

fn query_params(query: &str) -> std::collections::HashMap<String, String> {
    let mut params = std::collections::HashMap::new();
    for pair in query.split('&').filter(|part| !part.is_empty()) {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let value = parts.next().unwrap_or("");
        if let (Ok(key), Ok(value)) = (
            urlencoding::decode(key),
            urlencoding::decode(value),
        ) {
            params.insert(key.into_owned(), value.into_owned());
        }
    }
    params
}

pub fn tmdb_allowed(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        ["trending", "movie" | "tv", "day" | "week"] => true,
        ["movie" | "tv", id] if is_digits(id) => true,
        ["movie" | "tv", "now_playing" | "on_the_air" | "popular" | "top_rated"] => true,
        ["tv", id, "season", season] if is_digits(id) && is_digits(season) => true,
        ["search", "movie" | "tv" | "multi"] => true,
        _ => false,
    }
}

fn torrentio_allowed(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("stream/") else {
        return false;
    };
    imdb_json_path(rest, false)
}

fn subtitles_allowed(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("subtitles/") else {
        return false;
    };
    imdb_json_path(rest, true)
}

fn imdb_json_path(path: &str, extra_segment: bool) -> bool {
    let Some(path) = path.strip_suffix(".json") else {
        return false;
    };
    let mut parts = path.split('/');
    let Some(kind) = parts.next() else {
        return false;
    };
    if kind != "movie" && kind != "series" {
        return false;
    }
    let Some(id) = parts.next() else {
        return false;
    };
    if !imdb_id(id) {
        return false;
    }
    if extra_segment {
        if let Some(extra) = parts.next() {
            if extra.is_empty()
                || !extra
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '=' | '.' | '-'))
            {
                return false;
            }
        }
    }
    parts.next().is_none()
}

fn imdb_id(value: &str) -> bool {
    let mut parts = value.split(':');
    let Some(tt) = parts.next() else {
        return false;
    };
    if !tt.starts_with("tt") || !is_digits(&tt[2..]) || tt.len() <= 2 {
        return false;
    }
    match (parts.next(), parts.next(), parts.next()) {
        (None, None, None) => true,
        (Some(season), Some(episode), None) => is_digits(season) && is_digits(episode),
        _ => false,
    }
}

fn is_digits(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit())
}

fn to_web_vtt(source: &str) -> String {
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.trim_start().starts_with("WEBVTT") {
        return normalized;
    }
    let mut out = String::from("WEBVTT\n\n");
    out.push_str(&srt_commas_to_dots(&normalized));
    out
}

fn srt_commas_to_dots(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 12 <= bytes.len()
            && bytes[i].is_ascii_digit()
            && bytes[i + 1].is_ascii_digit()
            && bytes[i + 2] == b':'
            && bytes[i + 3].is_ascii_digit()
            && bytes[i + 4].is_ascii_digit()
            && bytes[i + 5] == b':'
            && bytes[i + 6].is_ascii_digit()
            && bytes[i + 7].is_ascii_digit()
            && bytes[i + 8] == b','
            && bytes[i + 9].is_ascii_digit()
            && bytes[i + 10].is_ascii_digit()
            && bytes[i + 11].is_ascii_digit()
        {
            out.push_str(&source[i..i + 8]);
            out.push('.');
            out.push_str(&source[i + 9..i + 12]);
            i += 12;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{imdb_id, srt_commas_to_dots, tmdb_allowed, torrentio_allowed};

    #[test]
    fn tmdb_allowlist_matches_the_app() {
        assert!(tmdb_allowed("trending/movie/week"));
        assert!(tmdb_allowed("movie/550"));
        assert!(tmdb_allowed("tv/1396/season/1"));
        assert!(tmdb_allowed("search/multi"));
        assert!(!tmdb_allowed("movie/550/credits"));
        assert!(!tmdb_allowed("configuration"));
    }

    #[test]
    fn torrentio_allowlist_is_one_title() {
        assert!(torrentio_allowed("stream/movie/tt0137523.json"));
        assert!(torrentio_allowed("stream/series/tt0944947:1:1.json"));
        assert!(!torrentio_allowed("stream/movie/not-imdb.json"));
        assert!(!torrentio_allowed("catalog/movie/top.json"));
    }

    #[test]
    fn imdb_ids_accept_optional_episode() {
        assert!(imdb_id("tt0137523"));
        assert!(imdb_id("tt0944947:2:3"));
        assert!(!imdb_id("tt"));
        assert!(!imdb_id("tt0944947:2"));
    }

    #[test]
    fn srt_timestamps_become_webvtt() {
        assert_eq!(
            srt_commas_to_dots("00:01:02,345 --> 00:01:03,000"),
            "00:01:02.345 --> 00:01:03.000"
        );
    }
}
