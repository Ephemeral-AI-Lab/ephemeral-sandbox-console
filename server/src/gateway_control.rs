//! Local gateway controls exposed to the console UI.
//!
//! The route is intentionally narrow: it starts only the configured
//! Ephemeral Sandbox gateway helper and reports readiness after a real gateway
//! RPC succeeds.

use std::process::{Command, Stdio};
use std::time::Duration;

use http::{Response, StatusCode};
use sandbox_operation_contract::{error_response_with_details, OperationRequest, OperationScope};
use serde_json::{json, Value};
use tokio::time::{sleep, Instant};

use crate::response::{self, BoxBody};
use crate::state::AppState;

const READINESS_POLL_INTERVAL: Duration = Duration::from_millis(250);

pub async fn start(state: &AppState) -> Response<BoxBody> {
    if gateway_is_ready(state).await {
        return response::json_value(
            StatusCode::OK,
            &json!({
                "status": "already_running",
                "message": "Gateway is already reachable.",
            }),
        );
    }

    let Some(starter) = state.config.gateway_start.as_ref() else {
        return gateway_control_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "gateway_start_unavailable",
            "Gateway start is not configured for this console.",
        );
    };

    if !starter.program.is_file() {
        return gateway_control_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "gateway_start_unavailable",
            &format!(
                "Gateway starter was not found at {}. Build the core gateway first.",
                starter.program.display()
            ),
        );
    }

    if let Err(error) = spawn_gateway(starter) {
        return gateway_control_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "gateway_start_failed",
            &format!("Gateway starter failed to launch: {error}"),
        );
    }

    if wait_until_ready(state, starter.readiness_timeout).await {
        response::json_value(
            StatusCode::OK,
            &json!({
                "status": "started",
                "message": "Gateway started.",
            }),
        )
    } else {
        gateway_control_error(
            StatusCode::GATEWAY_TIMEOUT,
            "gateway_start_timeout",
            "Gateway starter launched, but the gateway did not become ready before the timeout.",
        )
    }
}

fn spawn_gateway(starter: &crate::config::GatewayStartConfig) -> std::io::Result<()> {
    let mut command = Command::new(&starter.program);
    command
        .args(&starter.args)
        .current_dir(&starter.working_dir)
        .envs(starter.env.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn()?;
    tokio::task::spawn_blocking(move || {
        let _ = child.wait();
    });
    Ok(())
}

async fn wait_until_ready(state: &AppState, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if gateway_is_ready(state).await {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        sleep(READINESS_POLL_INTERVAL).await;
    }
}

async fn gateway_is_ready(state: &AppState) -> bool {
    let request = OperationRequest::new(
        "list_sandboxes",
        uuid::Uuid::new_v4().to_string(),
        OperationScope::System,
        Value::Object(serde_json::Map::new()),
    );
    state
        .gateway
        .send(&request)
        .await
        .is_ok_and(|response| response.get("error").is_none())
}

fn gateway_control_error(status: StatusCode, kind: &str, message: &str) -> Response<BoxBody> {
    response::json_value(
        status,
        &error_response_with_details(kind, message, json!({})),
    )
}
