//! Static SPA asset serving with client-route fallback. Unknown extensions
//! and missing files fall back to `index.html` so deep links resolve from a
//! cold load; a built-in placeholder page covers the unbuilt-SPA case.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use http::header::{HeaderValue, CONTENT_SECURITY_POLICY};
use http::StatusCode;
use hyper::Response;
use serde::Deserialize;

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
const CONSOLE_CSP: &str = "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; form-action 'self'";
const VITE_MANIFEST_PATH: &str = ".vite/manifest.json";
const SHARED_ASSET_MANIFEST_PATH: &str = ".vite/shared-assets-manifest.json";
const SHARED_PUBLIC_PREFIX: &str = "shared/public/";

#[derive(Debug, Default)]
pub(crate) struct AssetCachePolicy {
    immutable_paths: HashSet<PathBuf>,
}

#[derive(Deserialize)]
struct ViteManifestChunk {
    file: String,
    #[serde(default)]
    css: Vec<String>,
    #[serde(default)]
    assets: Vec<String>,
}

#[derive(Deserialize)]
struct SharedAssetManifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u8,
    product: String,
    derivatives: SharedDerivatives,
}

#[derive(Deserialize)]
struct SharedDerivatives {
    web: HashMap<String, SharedAssetRecord>,
}

#[derive(Deserialize)]
struct SharedAssetRecord {
    path: String,
}

impl AssetCachePolicy {
    pub(crate) fn load(assets_dir: Option<&Path>) -> Self {
        let Some(assets_dir) = assets_dir else {
            return Self::default();
        };
        let mut immutable_paths = HashSet::new();

        if let Some(manifest) =
            read_json::<HashMap<String, ViteManifestChunk>>(&assets_dir.join(VITE_MANIFEST_PATH))
        {
            for chunk in manifest.into_values() {
                for path in std::iter::once(chunk.file)
                    .chain(chunk.css)
                    .chain(chunk.assets)
                {
                    if let Some(path) = manifest_path(&path) {
                        if path.starts_with("assets") {
                            immutable_paths.insert(path);
                        }
                    }
                }
            }
        }

        if let Some(manifest) =
            read_json::<SharedAssetManifest>(&assets_dir.join(SHARED_ASSET_MANIFEST_PATH))
        {
            if manifest.schema_version == 1 && manifest.product == "Ephemeral Sandbox" {
                for record in manifest.derivatives.web.into_values() {
                    if let Some(path) = record
                        .path
                        .strip_prefix(SHARED_PUBLIC_PREFIX)
                        .and_then(manifest_path)
                    {
                        if path.starts_with("brand") {
                            immutable_paths.insert(path);
                        }
                    }
                }
            }
        }

        Self { immutable_paths }
    }

    fn is_immutable(&self, relative: &Path) -> bool {
        self.immutable_paths.contains(relative)
    }
}

pub async fn serve(assets_dir: Option<&Path>, uri_path: &str) -> Response<BoxBody> {
    let cache_policy = AssetCachePolicy::load(assets_dir);
    serve_with_cache_policy(assets_dir, &cache_policy, uri_path).await
}

pub(crate) async fn serve_with_cache_policy(
    assets_dir: Option<&Path>,
    cache_policy: &AssetCachePolicy,
    uri_path: &str,
) -> Response<BoxBody> {
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
        Some(body) => file_response(&candidate, &relative, cache_policy, body),
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

fn manifest_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        return None;
    }
    sanitize(path)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

async fn read_file(path: &Path) -> Option<Vec<u8>> {
    if !path.is_file() {
        return None;
    }
    tokio::fs::read(path).await.ok()
}

fn file_response(
    path: &Path,
    relative: &Path,
    cache_policy: &AssetCachePolicy,
    body: Vec<u8>,
) -> Response<BoxBody> {
    let content_type = content_type_for(path);
    let mut response = Response::new(response::full(body));
    response.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static(content_type),
    );
    if content_type.starts_with("text/html") {
        html_document(response)
    } else {
        let cache_control = if cache_policy.is_immutable(relative) {
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
        HeaderValue::from_static(CONSOLE_CSP),
    );
    response
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
