use std::time::Duration;

use http::header::{CACHE_CONTROL, COOKIE, HOST, LOCATION, ORIGIN, SET_COOKIE};
use http::{Method, Request, StatusCode};
use sandbox_console::auth::{DESKTOP_BOOTSTRAP_PATH, DESKTOP_SESSION_COOKIE};

use crate::support;

const NONCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async fn request(
    console: std::net::SocketAddr,
    method: Method,
    path: &str,
    host: &str,
    cookie: Option<&str>,
    origin: Option<&str>,
) -> http::Response<hyper::body::Incoming> {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(HOST, host);
    if let Some(cookie) = cookie {
        builder = builder.header(COOKIE, cookie);
    }
    if let Some(origin) = origin {
        builder = builder.header(ORIGIN, origin);
    }
    let request = builder
        .body(support::empty_body())
        .expect("build desktop auth request");
    support::send_request(console, request).await.0
}

#[tokio::test]
async fn bootstrap_nonce_is_single_use_and_establishes_an_httponly_session() {
    let gateway = support::FakeGateway::spawn(|_| Vec::new()).await;
    let console = support::spawn_console_with_desktop_auth(
        gateway.addr,
        None,
        Duration::from_secs(5),
        Some((NONCE, SESSION)),
    )
    .await;
    let authority = console.to_string();
    let bootstrap = format!("{DESKTOP_BOOTSTRAP_PATH}?nonce={NONCE}");

    let unauthenticated =
        request(console, Method::GET, "/api/catalog", &authority, None, None).await;
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(unauthenticated.headers()[CACHE_CONTROL], "no-store");

    let wrong_host = request(
        console,
        Method::GET,
        &bootstrap,
        "localhost.invalid",
        None,
        None,
    )
    .await;
    assert_eq!(wrong_host.status(), StatusCode::MISDIRECTED_REQUEST);

    let response = request(console, Method::GET, &bootstrap, &authority, None, None).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(response.headers()[LOCATION], "/");
    assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    let set_cookie = response.headers()[SET_COOKIE]
        .to_str()
        .expect("session cookie is text");
    assert!(set_cookie.starts_with(&format!("{DESKTOP_SESSION_COOKIE}={SESSION};")));
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Strict"));
    assert!(set_cookie.contains("Path=/"));

    let replay = request(console, Method::GET, &bootstrap, &authority, None, None).await;
    assert_eq!(replay.status(), StatusCode::FORBIDDEN);

    let cookie = format!("{DESKTOP_SESSION_COOKIE}={SESSION}");
    let authenticated = request(console, Method::GET, "/", &authority, Some(&cookie), None).await;
    assert_eq!(authenticated.status(), StatusCode::OK);
}

#[tokio::test]
async fn desktop_api_and_preview_require_the_session_and_reject_foreign_origins() {
    let gateway = support::FakeGateway::spawn(|request| {
        let sandbox_id = request["args"]["sandbox_id"].as_str().unwrap_or_default();
        vec![support::not_found_line(sandbox_id)]
    })
    .await;
    let console = support::spawn_console_with_desktop_auth(
        gateway.addr,
        None,
        Duration::from_secs(5),
        Some((NONCE, SESSION)),
    )
    .await;
    let authority = console.to_string();
    let cookie = format!("{DESKTOP_SESSION_COOKIE}={SESSION}");

    let preview = request(
        console,
        Method::GET,
        "/s/eos-1/shared/5173/",
        &authority,
        None,
        None,
    )
    .await;
    assert_eq!(preview.status(), StatusCode::UNAUTHORIZED);

    let foreign = request(
        console,
        Method::GET,
        "/api/catalog",
        &authority,
        Some(&cookie),
        Some("https://attacker.invalid"),
    )
    .await;
    assert_eq!(foreign.status(), StatusCode::FORBIDDEN);

    let foreign_preview = request(
        console,
        Method::POST,
        "/s/eos-1/shared/5173/",
        &authority,
        Some(&cookie),
        Some("http://127.0.0.1:3000"),
    )
    .await;
    assert_eq!(foreign_preview.status(), StatusCode::FORBIDDEN);

    let opaque_preview = request(
        console,
        Method::GET,
        "/s/eos-1/shared/5173/",
        &authority,
        Some(&cookie),
        Some("null"),
    )
    .await;
    assert_eq!(opaque_preview.status(), StatusCode::NOT_FOUND);

    let allowed_origin = format!("http://{authority}");
    let allowed = request(
        console,
        Method::GET,
        "/api/catalog",
        &authority,
        Some(&cookie),
        Some(&allowed_origin),
    )
    .await;
    assert_eq!(allowed.status(), StatusCode::OK);

    let wrong_cookie = format!(
        "{DESKTOP_SESSION_COOKIE}=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    );
    let denied = request(
        console,
        Method::GET,
        "/api/catalog",
        &authority,
        Some(&wrong_cookie),
        Some(&allowed_origin),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
}
