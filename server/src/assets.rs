//! Static SPA asset serving with client-route fallback. Unknown extensions
//! and missing files fall back to `index.html` so deep links resolve from a
//! cold load; a built-in placeholder page covers the unbuilt-SPA case.

use std::path::{Component, Path, PathBuf};

use http::header::{HeaderValue, CONTENT_SECURITY_POLICY};
use http::StatusCode;
use hyper::Response;

use crate::response::{self, BoxBody};

const PLACEHOLDER_PAGE: &str = "<!doctype html>\
<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Ephemeral Sandbox Console</title></head>\
<body style=\"font-family: system-ui; margin: 4rem auto; max-width: 40rem; color: #1a1d21;\">\
<h1>Ephemeral Sandbox Console</h1>\
<p>The console server is running, but the SPA assets are not built.</p>\
<p>Build them with <code>bin/package-console</code>, then reload.</p>\
</body></html>";

const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL: &str = "public, max-age=0, must-revalidate";

pub async fn serve(assets_dir: Option<&Path>, uri_path: &str) -> Response<BoxBody> {
    let Some(assets_dir) = assets_dir else {
        return html_document(response::html(StatusCode::OK, PLACEHOLDER_PAGE));
    };
    let Some(relative) = sanitize(uri_path) else {
        return response::text(StatusCode::BAD_REQUEST, "invalid asset path");
    };
    let candidate = if relative.as_os_str().is_empty() {
        assets_dir.join("index.html")
    } else {
        assets_dir.join(&relative)
    };
    match read_file(&candidate).await {
        Some(body) => file_response(&candidate, body),
        None => match read_file(&assets_dir.join("index.html")).await {
            Some(body) => html_document(response::html(StatusCode::OK, body)),
            None => html_document(response::html(StatusCode::OK, PLACEHOLDER_PAGE)),
        },
    }
}

fn sanitize(uri_path: &str) -> Option<PathBuf> {
    let trimmed = uri_path.trim_start_matches('/');
    let mut relative = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(relative)
}

async fn read_file(path: &Path) -> Option<Vec<u8>> {
    if !path.is_file() {
        return None;
    }
    tokio::fs::read(path).await.ok()
}

fn file_response(path: &Path, body: Vec<u8>) -> Response<BoxBody> {
    let content_type = content_type_for(path);
    let mut response = Response::new(response::full(body));
    response.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static(content_type),
    );
    if content_type.starts_with("text/html") {
        html_document(response)
    } else {
        let cache_control = if has_content_hash(path) {
            IMMUTABLE_CACHE_CONTROL
        } else {
            REVALIDATE_CACHE_CONTROL
        };
        response.headers_mut().insert(
            http::header::CACHE_CONTROL,
            http::HeaderValue::from_static(cache_control),
        );
        response
    }
}

fn html_document(response: Response<BoxBody>) -> Response<BoxBody> {
    let mut response = response::no_store(response);
    response.headers_mut().append(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("frame-src 'self'"),
    );
    response
}

fn has_content_hash(path: &Path) -> bool {
    let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else {
        return false;
    };
    stem.char_indices()
        .filter(|(_, character)| matches!(character, '-' | '.'))
        .map(|(index, _)| &stem[index + 1..])
        .any(is_hash_suffix)
}

fn is_hash_suffix(suffix: &str) -> bool {
    if !suffix
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return false;
    }
    // Vite emits eight-character base64url hashes. Asset-pipeline derivatives
    // use a hexadecimal source-hash prefix (currently eight characters, but
    // accepting a longer digest keeps the cache rule format-independent).
    suffix.len() == 8
        || ((8..=64).contains(&suffix.len()) && suffix.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::has_content_hash;
    use std::path::Path;

    #[test]
    fn content_hash_detection_uses_the_filename_not_its_directory() {
        for path in [
            "assets/index-BDcRxxNq.js",
            "assets/index-CkijG-Lv.js",
            "assets/index-vlm8_aqG.css",
            "brand/ephemeral-sandbox-mascot-b9408770.webp",
            "styles/app.0123456789abcdef.css",
        ] {
            assert!(has_content_hash(Path::new(path)), "{path}");
        }
        for path in [
            "assets/app.js",
            "assets/dashboard.css",
            "brand/ephemeral-sandbox-mascot.webp",
            "fonts/inter-latin-400-v18.woff2",
        ] {
            assert!(!has_content_hash(Path::new(path)), "{path}");
        }
    }
}
