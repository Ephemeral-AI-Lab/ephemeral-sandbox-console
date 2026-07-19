//! Top-level HTTP routing: dispatch the six public console routes to their
//! responders and everything else to the SPA asset fallback.

use std::sync::Arc;

use http::header::{CONTENT_TYPE, ORIGIN};
use http::{Method, Request, Response, StatusCode};
use hyper::body::Incoming;

use crate::auth::DESKTOP_BOOTSTRAP_PATH;
use crate::response::{self, BoxBody};
use crate::state::AppState;
use crate::{assets, catalog, daemon_api, gateway_control, health, proxy, rpc, sandbox_clusters};

pub async fn route(state: Arc<AppState>, req: Request<Incoming>) -> Response<BoxBody> {
    let path = req.uri().path().to_owned();
    if let Some(auth) = state.desktop_auth.as_ref() {
        if !auth.has_expected_host(req.headers()) {
            return response::no_store(response::text(
                StatusCode::MISDIRECTED_REQUEST,
                "request authority does not match the desktop BFF",
            ));
        }
        if path == DESKTOP_BOOTSTRAP_PATH {
            if req.method() != Method::GET {
                return response::no_store(response::text(
                    StatusCode::METHOD_NOT_ALLOWED,
                    "use GET",
                ));
            }
            return auth.bootstrap_response(req.uri());
        }
        if !auth.has_session(req.headers()) {
            return response::no_store(response::text(
                StatusCode::UNAUTHORIZED,
                "desktop session required",
            ));
        }
        if path.starts_with("/api/") && has_opaque_origin(req.headers()) {
            return response::no_store(response::text(
                StatusCode::FORBIDDEN,
                "opaque origins cannot call console APIs",
            ));
        }
        let guarded_route = path.starts_with("/api/") || path.starts_with("/s/");
        let allowed_preview_origin = path.starts_with("/s/") && has_opaque_origin(req.headers());
        if guarded_route && !allowed_preview_origin && !auth.has_allowed_origin(req.headers()) {
            return response::no_store(response::text(
                StatusCode::FORBIDDEN,
                "cross-origin requests cannot call desktop BFF routes",
            ));
        }
    }
    // A Preview document has an opaque sandbox origin and therefore sends
    // `Origin: null` for unsafe fetches. It must never invoke Console APIs,
    // even if untrusted script attempts a same-host relative request.
    if path.starts_with("/api/") && has_opaque_origin(req.headers()) {
        return response::text(
            StatusCode::FORBIDDEN,
            "opaque origins cannot call console APIs",
        );
    }
    if path == "/api/rpc" {
        if req.method() != Method::POST {
            return response::text(StatusCode::METHOD_NOT_ALLOWED, "use POST");
        }
        return rpc::handle(&state, req).await;
    }
    if path == "/api/catalog" {
        if req.method() != Method::GET {
            return response::text(StatusCode::METHOD_NOT_ALLOWED, "use GET");
        }
        return catalog::handle();
    }
    if path == "/api/gateway/start" {
        if req.method() != Method::POST {
            return response::text(StatusCode::METHOD_NOT_ALLOWED, "use POST");
        }
        if !has_json_content_type(req.headers()) {
            return response::text(StatusCode::UNSUPPORTED_MEDIA_TYPE, "use application/json");
        }
        return gateway_control::start(&state).await;
    }
    if path == "/api/sandbox-clusters" {
        return sandbox_clusters::handle(&state.sandbox_clusters, req).await;
    }
    if let Some(route) = daemon_api::route(&path) {
        if req.method() != Method::POST {
            return response::text(StatusCode::METHOD_NOT_ALLOWED, "use POST");
        }
        return daemon_api::handle(&state, route, req).await;
    }
    if let Some(sandbox_id) = health_route(&path) {
        if req.method() != Method::GET {
            return response::text(StatusCode::METHOD_NOT_ALLOWED, "use GET");
        }
        return health::handle(&state, sandbox_id).await;
    }
    if path.starts_with("/s/") {
        return proxy::handle(&state, req).await;
    }
    if path.starts_with("/api/") {
        return response::text(StatusCode::NOT_FOUND, "unknown api route");
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return response::text(StatusCode::METHOD_NOT_ALLOWED, "use GET");
    }
    assets::serve_with_cache_policy(
        state.config.assets_dir.as_deref(),
        &state.asset_cache,
        &path,
    )
    .await
}

fn has_opaque_origin(headers: &http::HeaderMap) -> bool {
    headers
        .get_all(ORIGIN)
        .iter()
        .any(|origin| origin.as_bytes() == b"null")
}

fn has_json_content_type(headers: &http::HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(';').next().is_some_and(|media_type| {
                media_type.trim().eq_ignore_ascii_case("application/json")
            })
        })
}

fn health_route(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/api/sandboxes/")?;
    let sandbox_id = rest.strip_suffix("/health")?;
    if sandbox_id.is_empty() || sandbox_id.contains('/') {
        return None;
    }
    Some(sandbox_id)
}

#[cfg(test)]
mod tests {
    use http::{HeaderMap, HeaderValue};

    use super::has_opaque_origin;

    #[test]
    fn opaque_origin_is_recognized_without_rejecting_normal_console_requests() {
        let mut headers = HeaderMap::new();
        headers.insert("origin", HeaderValue::from_static("null"));
        assert!(has_opaque_origin(&headers));

        headers.insert("origin", HeaderValue::from_static("http://127.0.0.1:4173"));
        assert!(!has_opaque_origin(&headers));

        headers.append("origin", HeaderValue::from_static("null"));
        assert!(has_opaque_origin(&headers));
    }
}
