use std::path::PathBuf;
use std::time::Duration;

use http::header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE};
use http::StatusCode;

use crate::support;

const CONSOLE_CSP: &str = "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; form-action 'self'";

fn temp_assets_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("console-assets-{}", uuid::Uuid::new_v4()));
    for child in [".vite", "assets", "brand", "fonts"] {
        std::fs::create_dir_all(dir.join(child)).expect("create asset dirs");
    }
    std::fs::write(dir.join("index.html"), "<html>console-index</html>").expect("write index");
    std::fs::write(dir.join("assets/app.js"), "console.log('app')").expect("write app.js");
    std::fs::write(dir.join("assets/index-ghijklmn.js"), "console.log('vite')")
        .expect("write Vite output");
    std::fs::write(dir.join("assets/index-ghijklmq.css"), "body{}").expect("write Vite CSS output");
    std::fs::write(
        dir.join("assets/release-20260718.js"),
        "console.log('dated')",
    )
    .expect("write dated app.js");
    std::fs::write(
        dir.join("assets/unlisted-deadbeef.js"),
        "console.log('unlisted')",
    )
    .expect("write unlisted app.js");
    std::fs::write(dir.join("assets/logo-original.png"), b"not-a-logo").expect("write stable logo");
    std::fs::write(dir.join("assets/replaceable.json"), "{}").expect("write stable public asset");
    std::fs::write(
        dir.join("brand/ephemeral-sandbox-mascot-b9408770.webp"),
        b"RIFFtestWEBP",
    )
    .expect("write WebP asset");
    std::fs::write(
        dir.join("fonts/inter-latin-100-900-v5.2.8.woff2"),
        b"wOF2test",
    )
    .expect("write versioned font");
    std::fs::write(
        dir.join(".vite/manifest.json"),
        r#"{"index.html":{"file":"assets/index-ghijklmn.js","css":["assets/index-ghijklmq.css"]}}"#,
    )
    .expect("write Vite manifest");
    std::fs::write(
        dir.join(".vite/shared-assets-manifest.json"),
        r#"{"schemaVersion":1,"product":"Ephemeral Sandbox","derivatives":{"web":{"webp":{"path":"shared/public/brand/ephemeral-sandbox-mascot-b9408770.webp"}}}}"#,
    )
    .expect("write shared asset manifest");
    dir
}

#[tokio::test]
async fn missing_assets_dir_serves_placeholder() {
    let gateway = support::FakeGateway::spawn(|_| Vec::new()).await;
    let console = support::spawn_console_default(gateway.addr).await;

    let response = support::get(console, "/").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[CONTENT_SECURITY_POLICY], CONSOLE_CSP);
    let text = support::body_text(response).await;
    assert!(text.contains("SPA assets are not built"));
}

#[tokio::test]
async fn serves_files_and_falls_back_to_index_for_client_routes() {
    let gateway = support::FakeGateway::spawn(|_| Vec::new()).await;
    let assets = temp_assets_dir();
    let console =
        support::spawn_console(gateway.addr, Some(assets.clone()), Duration::from_secs(5)).await;

    let response = support::get(console, "/assets/app.js").await;
    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response
        .headers()
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    assert!(content_type.starts_with("text/javascript"));
    assert_eq!(
        response.headers()[CACHE_CONTROL],
        "public, max-age=0, must-revalidate"
    );
    let text = support::body_text(response).await;
    assert_eq!(text, "console.log('app')");

    for client_route in [
        "/",
        "/index.html",
        "/sandboxes/eos-1/terminal",
        "/deep/link?x=1",
    ] {
        let response = support::get(console, client_route).await;
        assert_eq!(response.status(), StatusCode::OK, "route: {client_route}");
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()[CONTENT_SECURITY_POLICY], CONSOLE_CSP);
        let text = support::body_text(response).await;
        assert!(text.contains("console-index"), "route: {client_route}");
    }

    std::fs::remove_dir_all(assets).expect("clean temp assets");
}

#[tokio::test]
async fn manifest_members_are_immutable_even_with_an_all_lowercase_vite_hash() {
    let gateway = support::FakeGateway::spawn(|_| Vec::new()).await;
    let assets = temp_assets_dir();
    let console =
        support::spawn_console(gateway.addr, Some(assets.clone()), Duration::from_secs(5)).await;

    for path in ["/assets/index-ghijklmn.js", "/assets/index-ghijklmq.css"] {
        let response = support::get(console, path).await;
        assert_eq!(
            response.headers()[CACHE_CONTROL],
            "public, max-age=31536000, immutable",
            "path: {path}"
        );
    }

    std::fs::remove_dir_all(assets).expect("clean temp assets");
}

#[tokio::test]
async fn unlisted_hash_like_date_and_version_filenames_revalidate() {
    let gateway = support::FakeGateway::spawn(|_| Vec::new()).await;
    let assets = temp_assets_dir();
    let console =
        support::spawn_console(gateway.addr, Some(assets.clone()), Duration::from_secs(5)).await;

    for path in [
        "/assets/release-20260718.js",
        "/assets/unlisted-deadbeef.js",
        "/assets/logo-original.png",
        "/assets/replaceable.json",
        "/fonts/inter-latin-100-900-v5.2.8.woff2",
    ] {
        let response = support::get(console, path).await;
        assert_eq!(
            response.headers()[CACHE_CONTROL],
            "public, max-age=0, must-revalidate",
            "path: {path}"
        );
    }

    std::fs::remove_dir_all(assets).expect("clean temp assets");
}

#[tokio::test]
async fn shared_manifest_webp_member_is_immutable_and_has_its_mime_type() {
    let gateway = support::FakeGateway::spawn(|_| Vec::new()).await;
    let assets = temp_assets_dir();
    let console =
        support::spawn_console(gateway.addr, Some(assets.clone()), Duration::from_secs(5)).await;

    let webp = support::get(console, "/brand/ephemeral-sandbox-mascot-b9408770.webp").await;
    assert_eq!(webp.headers()[CONTENT_TYPE], "image/webp");
    assert_eq!(
        webp.headers()[CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );

    std::fs::remove_dir_all(assets).expect("clean temp assets");
}

#[tokio::test]
async fn invalid_manifests_fail_closed_to_revalidation() {
    let gateway = support::FakeGateway::spawn(|_| Vec::new()).await;
    let assets = temp_assets_dir();
    std::fs::write(assets.join(".vite/manifest.json"), "{").expect("write malformed Vite manifest");
    std::fs::write(
        assets.join(".vite/shared-assets-manifest.json"),
        r#"{"schemaVersion":1,"product":"Wrong Product","derivatives":{"web":{"webp":{"path":"shared/public/brand/ephemeral-sandbox-mascot-b9408770.webp"}}}}"#,
    )
    .expect("write wrong-product shared manifest");
    let console =
        support::spawn_console(gateway.addr, Some(assets.clone()), Duration::from_secs(5)).await;

    for path in [
        "/assets/index-ghijklmn.js",
        "/brand/ephemeral-sandbox-mascot-b9408770.webp",
    ] {
        let response = support::get(console, path).await;
        assert_eq!(
            response.headers()[CACHE_CONTROL],
            "public, max-age=0, must-revalidate",
            "path: {path}"
        );
    }

    std::fs::remove_dir_all(assets).expect("clean temp assets");
}

#[tokio::test]
async fn path_traversal_is_rejected() {
    let gateway = support::FakeGateway::spawn(|_| Vec::new()).await;
    let assets = temp_assets_dir();
    let console =
        support::spawn_console(gateway.addr, Some(assets.clone()), Duration::from_secs(5)).await;

    let response = support::get(console, "/../Cargo.toml").await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    std::fs::remove_dir_all(assets).expect("clean temp assets");
}
