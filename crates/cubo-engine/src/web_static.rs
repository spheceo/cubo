//! Serves the Vite `dist` that release builds embed next to Core. Debug
//! builds still proxy the local Vite server; this module is the release path
//! and the fallback when that proxy is unset.

use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use include_dir::{include_dir, Dir};

static WEB: Dir<'_> = include_dir!("$OUT_DIR/cubo-web");

pub fn serve(path: &str) -> Response {
    let relative = requested_file(path);
    if let Some(file) = WEB.get_file(&relative) {
        return file_response(&relative, file.contents());
    }
    if looks_like_asset(&relative) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match WEB.get_file("index.html") {
        Some(index) => file_response("index.html", index.contents()),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn requested_file(path: &str) -> String {
    let trimmed = path.split('?').next().unwrap_or(path).trim_start_matches('/');
    if trimmed.is_empty() || trimmed.contains("..") {
        return "index.html".into();
    }
    trimmed.to_owned()
}

fn looks_like_asset(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .is_some_and(|ext| !ext.is_empty())
}

fn cache_policy(path: &str) -> &'static str {
    // Vite fingerprints generated assets. Public files keep stable names
    // and must revalidate after an upgrade (icons, manifests, etc.).
    if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

fn file_response(path: &str, bytes: &'static [u8]) -> Response {
    let mime = mime_for(path);
    let cache = cache_policy(path);
    (
        [
            (CONTENT_TYPE, HeaderValue::from_static(mime)),
            (CACHE_CONTROL, HeaderValue::from_static(cache)),
        ],
        bytes,
    )
        .into_response()
}

fn mime_for(path: &str) -> &'static str {
    match std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "json" | "webmanifest" => "application/json",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::requested_file;

    #[test]
    fn only_versioned_assets_are_immutable() {
        assert!(super::cache_policy("assets/app-123.js").contains("immutable"));
        for path in ["index.html", "manifest.webmanifest", "favicon.ico"] {
            assert_eq!(super::cache_policy(path), "no-cache");
        }
    }

    #[test]
    fn root_and_dot_dot_become_index() {
        assert_eq!(requested_file("/"), "index.html");
        assert_eq!(requested_file("/../secret"), "index.html");
        assert_eq!(requested_file("/assets/app.js"), "assets/app.js");
    }
}
