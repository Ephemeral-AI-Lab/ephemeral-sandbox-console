//! The console HTTP listener: a loopback TCP accept loop serving each
//! connection over HTTP/1.1 with upgrade support so the preview proxy can
//! tunnel WebSockets.

use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use http::{Request, Response};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio::time::timeout;

use crate::response::BoxBody;
use crate::router;
use crate::state::AppState;

const CONNECTION_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// Bind the console listener and serve until the process exits.
///
/// # Errors
/// Returns an error when the bind address is invalid or the listener cannot
/// be bound.
pub async fn run(state: AppState) -> std::io::Result<()> {
    let listener = TcpListener::bind(state.config.bind.as_str()).await?;
    let local = listener.local_addr()?;
    println!(
        "sandbox-console listening on http://{local} (gateway {})",
        state.config.gateway.gateway_socket_path.display()
    );
    serve(listener, state).await
}

/// Serve console connections from an already-bound listener until the
/// process exits.
///
/// # Errors
/// Never returns `Ok`; the error type keeps the signature aligned with
/// [`run`].
pub async fn serve(listener: TcpListener, state: AppState) -> std::io::Result<()> {
    serve_until(listener, state, std::future::pending()).await
}

/// Serve console connections until `shutdown` resolves. Once requested, the
/// listener is closed, HTTP connections receive Hyper's graceful-shutdown
/// signal, and any connection that exceeds a short drain window is aborted.
///
/// # Errors
/// Returns an error if accepting a connection fails before shutdown.
pub async fn serve_until<F>(
    listener: TcpListener,
    state: AppState,
    shutdown: F,
) -> std::io::Result<()>
where
    F: Future<Output = ()> + Send,
{
    let state = Arc::new(state);
    let (connection_shutdown, _) = watch::channel(false);
    let mut connections = JoinSet::new();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                let (stream, peer) = accepted?;
                connections.spawn(serve_connection(
                    stream,
                    peer,
                    Arc::clone(&state),
                    connection_shutdown.subscribe(),
                ));
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }

    drop(listener);
    let _ = connection_shutdown.send(true);
    let drain = async { while connections.join_next().await.is_some() {} };
    if timeout(CONNECTION_SHUTDOWN_GRACE, drain).await.is_err() {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }
    Ok(())
}

async fn serve_connection(
    stream: TcpStream,
    peer: SocketAddr,
    state: Arc<AppState>,
    mut shutdown: watch::Receiver<bool>,
) {
    let service = service_fn(move |mut req: Request<Incoming>| {
        let state = Arc::clone(&state);
        req.extensions_mut().insert(peer);
        async move { Ok::<Response<BoxBody>, Infallible>(router::route(state, req).await) }
    });
    let connection = hyper::server::conn::http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades();
    tokio::pin!(connection);
    tokio::select! {
        _ = shutdown.changed() => {
            connection.as_mut().graceful_shutdown();
            let _ = connection.await;
        }
        _ = &mut connection => {}
    }
}
