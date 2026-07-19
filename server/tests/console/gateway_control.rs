use std::path::PathBuf;
use std::time::Duration;

use http::{Request, StatusCode};
use sandbox_console::config::GatewayStartConfig;
use serde_json::json;

use crate::support;

#[tokio::test]
async fn start_gateway_returns_already_running_without_start_config() {
    let gateway = support::FakeGateway::spawn(|_| vec![json!({"sandboxes": []}).to_string()]).await;
    let console = support::spawn_console_default(gateway.addr).await;

    let response = support::post_gateway_start(console).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = support::body_json(response).await;
    assert_eq!(body["status"], "already_running");
    assert_eq!(gateway.request_count(), 1);
}

#[tokio::test]
async fn start_gateway_reports_unavailable_without_start_config() {
    let closed = support::closed_port().await;
    let console = support::spawn_console_default(closed).await;

    let response = support::post_gateway_start(console).await;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = support::body_json(response).await;
    assert_eq!(body["error"]["kind"], "gateway_start_unavailable");
}

#[tokio::test]
async fn start_gateway_rejects_simple_form_posts() {
    let gateway = support::FakeGateway::spawn(|_| vec![json!({"sandboxes": []}).to_string()]).await;
    let console = support::spawn_console_default(gateway.addr).await;
    let request = Request::builder()
        .method(http::Method::POST)
        .uri("/api/gateway/start")
        .header(http::header::HOST, "console.test")
        .header(
            http::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(support::empty_body())
        .expect("build gateway start form request");

    let response = support::send_request(console, request).await.0;

    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(gateway.request_count(), 0);
}

#[tokio::test]
async fn start_gateway_spawns_configured_command_and_waits_until_ready() {
    let reserved = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("reserve gateway addr");
    let gateway_addr = reserved.local_addr().expect("gateway addr");
    drop(reserved);
    let marker = std::env::temp_dir().join(format!(
        "sandbox-console-gateway-start-{}.marker",
        uuid::Uuid::new_v4()
    ));
    let _ = std::fs::remove_file(&marker);

    let console = support::spawn_console_with_gateway_start(
        gateway_addr,
        Duration::from_secs(2),
        test_gateway_start_config_with_command(Duration::from_secs(2), marker_command(&marker)),
    )
    .await;
    tokio::spawn(async move {
        for _ in 0..100 {
            if marker.is_file() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let _gateway = support::FakeGateway::spawn_on(gateway_addr, |_| {
            vec![json!({"sandboxes": []}).to_string()]
        })
        .await;
        let _ = std::fs::remove_file(marker);
        tokio::time::sleep(Duration::from_secs(3)).await;
    });

    let response = support::post_gateway_start(console).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = support::body_json(response).await;
    assert_eq!(body["status"], "started");
}

#[tokio::test]
async fn start_gateway_times_out_when_starter_does_not_open_gateway() {
    let closed = support::closed_port().await;
    let console = support::spawn_console_with_gateway_start(
        closed,
        Duration::from_secs(2),
        test_gateway_start_config(Duration::from_millis(50)),
    )
    .await;

    let response = support::post_gateway_start(console).await;

    assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
    let body = support::body_json(response).await;
    assert_eq!(body["error"]["kind"], "gateway_start_timeout");
}

fn test_gateway_start_config(readiness_timeout: Duration) -> GatewayStartConfig {
    test_gateway_start_config_with_command(readiness_timeout, instant_success_command())
}

fn test_gateway_start_config_with_command(
    readiness_timeout: Duration,
    command: (PathBuf, Vec<String>),
) -> GatewayStartConfig {
    let (program, args) = command;
    GatewayStartConfig {
        program,
        args,
        working_dir: std::env::current_dir().expect("current dir"),
        env: Vec::new(),
        readiness_timeout,
    }
}

#[cfg(windows)]
fn marker_command(marker: &std::path::Path) -> (PathBuf, Vec<String>) {
    (
        std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe")),
        vec![
            "/d".to_owned(),
            "/c".to_owned(),
            format!("echo ready>\"{}\"", marker.display()),
        ],
    )
}

#[cfg(not(windows))]
fn marker_command(marker: &std::path::Path) -> (PathBuf, Vec<String>) {
    (
        PathBuf::from("/bin/sh"),
        vec![
            "-c".to_owned(),
            format!("printf ready > '{}'", marker.display()),
        ],
    )
}

#[cfg(windows)]
fn instant_success_command() -> (PathBuf, Vec<String>) {
    (
        std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe")),
        vec![
            "/d".to_owned(),
            "/c".to_owned(),
            "exit".to_owned(),
            "/b".to_owned(),
            "0".to_owned(),
        ],
    )
}

#[cfg(not(windows))]
fn instant_success_command() -> (PathBuf, Vec<String>) {
    (
        PathBuf::from("/bin/sh"),
        vec!["-c".to_owned(), "true".to_owned()],
    )
}
