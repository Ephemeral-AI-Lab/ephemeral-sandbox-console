use std::path::PathBuf;
use std::time::Duration;

use sandbox_console::config::ConsoleConfig;
use sandbox_console::server;
use sandbox_console::state::AppState;
use sandbox_operation_client::GatewayConfig;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use crate::support;

#[tokio::test]
async fn serve_until_stops_accepting_after_cancellation() {
    let gateway = support::FakeGateway::spawn(|_| Vec::new()).await;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind console");
    let addr = listener.local_addr().expect("console address");
    let config = ConsoleConfig {
        bind: addr.to_string(),
        gateway: GatewayConfig {
            gateway_socket_path: PathBuf::from(gateway.addr.to_string()),
            gateway_auth_token: Some(support::TEST_AUTH_TOKEN.to_owned()),
        },
        gateway_start: None,
        assets_dir: None,
        cluster_registry_path: std::env::temp_dir().join(format!(
            "sandbox-console-clusters-{}.json",
            uuid::Uuid::new_v4()
        )),
        rpc_timeout: Duration::from_secs(5),
        health_probe_timeout: Duration::from_secs(2),
        proxy_connect_timeout: Duration::from_secs(10),
        proxy_response_timeout: Duration::from_secs(30),
        endpoint_resolve_timeout: Duration::from_secs(5),
        endpoint_cache_ttl: Duration::from_secs(3),
    };
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server = tokio::spawn(server::serve_until(
        listener,
        AppState::new(config),
        async move {
            let _ = shutdown_rx.await;
        },
    ));

    let response = support::get(addr, "/").await;
    assert_eq!(response.status(), http::StatusCode::OK);
    let _ = support::body_text(response).await;

    shutdown_tx.send(()).expect("request shutdown");
    tokio::time::timeout(Duration::from_secs(1), server)
        .await
        .expect("server shuts down promptly")
        .expect("server task joins")
        .expect("server exits cleanly");
    assert!(TcpStream::connect(addr).await.is_err());
}
