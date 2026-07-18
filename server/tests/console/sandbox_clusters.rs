use http::{Method, Request, StatusCode};
use serde_json::{json, Value};

use crate::support;

#[tokio::test]
async fn cluster_registry_is_shared_by_all_console_origins_and_persists_exact_members() {
    let gateway = support::FakeGateway::spawn(|_| Vec::new()).await;
    let addr = support::spawn_console_default(gateway.addr).await;
    let cluster = json!({
        "id": "cluster-batch-a",
        "memberIds": ["sandbox-a", "sandbox-b"],
        "workspaceRoot": "/work/shared",
        "createdAt": "2026-07-18T00:00:00Z"
    });

    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/sandbox-clusters")
        .header(http::header::HOST, "localhost:5173")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(support::full_body(cluster.to_string()))
        .expect("build cluster request");
    let response = support::send_request(addr, request).await.0;
    assert_eq!(response.status(), StatusCode::OK);

    let response = support::get(addr, "/api/sandbox-clusters").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(&support::body_bytes(response).await)
        .expect("cluster registry json");
    assert_eq!(body, json!({ "clusters": [cluster] }));
}

#[tokio::test]
async fn cluster_registry_accepts_single_member_records() {
    let gateway = support::FakeGateway::spawn(|_| Vec::new()).await;
    let addr = support::spawn_console_default(gateway.addr).await;
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/sandbox-clusters")
        .header(http::header::HOST, "console.test")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(support::full_body(
            json!({
                "id": "cluster-single",
                "memberIds": ["sandbox-a"],
                "workspaceRoot": "/work/shared",
                "createdAt": "2026-07-18T00:00:00Z"
            })
            .to_string(),
        ))
        .expect("build single-member cluster request");

    let response = support::send_request(addr, request).await.0;
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn cluster_registry_removal_dissolves_only_the_requested_group() {
    let gateway = support::FakeGateway::spawn(|_| Vec::new()).await;
    let addr = support::spawn_console_default(gateway.addr).await;
    for id in ["cluster-a", "cluster-b"] {
        let cluster = json!({
            "id": id,
            "memberIds": [format!("{id}-one"), format!("{id}-two")],
            "workspaceRoot": "/work/shared",
            "createdAt": "2026-07-18T00:00:00Z"
        });
        let request = Request::builder()
            .method(Method::POST)
            .uri("/api/sandbox-clusters")
            .header(http::header::HOST, "localhost:5173")
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(support::full_body(cluster.to_string()))
            .expect("build cluster request");
        let response = support::send_request(addr, request).await.0;
        assert_eq!(response.status(), StatusCode::OK);
    }

    let request = Request::builder()
        .method(Method::DELETE)
        .uri("/api/sandbox-clusters")
        .header(http::header::HOST, "localhost:5173")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(support::full_body(json!({ "id": "cluster-a" }).to_string()))
        .expect("build cluster removal request");
    let response = support::send_request(addr, request).await.0;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&support::body_bytes(response).await).expect("cluster removal json");
    assert_eq!(body, json!({ "id": "cluster-a", "removed": true }));

    let response = support::get(addr, "/api/sandbox-clusters").await;
    let body: Value = serde_json::from_slice(&support::body_bytes(response).await)
        .expect("cluster registry json");
    assert_eq!(body["clusters"].as_array().map(Vec::len), Some(1));
    assert_eq!(body["clusters"][0]["id"], "cluster-b");
}
