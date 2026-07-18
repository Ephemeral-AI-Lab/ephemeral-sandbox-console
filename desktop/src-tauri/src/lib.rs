//! Thin Tauri host for the Ephemeral Sandbox web console.
//!
//! The WebView loads the same production Vite files as the browser build from
//! the existing Rust BFF. Tauri owns only resource resolution, window
//! lifecycle, and graceful server cancellation.

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener as StdTcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use sandbox_console::auth::{DesktopSessionAuth, DESKTOP_BOOTSTRAP_PATH};
use sandbox_console::config::{ConsoleConfig, ConsoleConfigOverrides};
use sandbox_console::server;
use sandbox_console::state::AppState;
use tauri::async_runtime::JoinHandle;
use tauri::path::BaseDirectory;
use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;
use tokio::time::timeout;
use uuid::Uuid;

const MAIN_WINDOW_LABEL: &str = "main";
const WEB_RESOURCE_DIR: &str = "web-dist";
const LOOPBACK_BIND: &str = "127.0.0.1:0";
const SERVER_EXIT_GRACE: Duration = Duration::from_secs(3);

type SetupResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Default)]
struct BffLifecycle {
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    server_task: Mutex<Option<JoinHandle<io::Result<()>>>>,
}

struct StartedBff {
    address: SocketAddr,
    bootstrap_url: Url,
    shutdown: oneshot::Sender<()>,
    server_task: JoinHandle<io::Result<()>>,
}

impl BffLifecycle {
    fn install(
        &self,
        shutdown: oneshot::Sender<()>,
        server_task: JoinHandle<io::Result<()>>,
    ) -> io::Result<()> {
        let mut shutdown_slot = lock_unpoisoned(&self.shutdown);
        let mut task_slot = lock_unpoisoned(&self.server_task);
        if shutdown_slot.is_some() || task_slot.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "desktop BFF lifecycle was already installed",
            ));
        }
        *shutdown_slot = Some(shutdown);
        *task_slot = Some(server_task);
        Ok(())
    }

    fn request_shutdown(&self) {
        if let Some(shutdown) = lock_unpoisoned(&self.shutdown).take() {
            let _ = shutdown.send(());
        }
    }

    fn wait_for_server(&self) -> io::Result<()> {
        let Some(server_task) = lock_unpoisoned(&self.server_task).take() else {
            return Ok(());
        };
        tauri::async_runtime::block_on(async move {
            match timeout(SERVER_EXIT_GRACE, server_task).await {
                Ok(Ok(result)) => result,
                Ok(Err(error)) => Err(io::Error::other(format!(
                    "desktop BFF task failed: {error}"
                ))),
                Err(_) => Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "desktop BFF did not stop within the shutdown grace period",
                )),
            }
        })
    }
}

impl Drop for BffLifecycle {
    fn drop(&mut self) {
        if let Ok(shutdown_slot) = self.shutdown.get_mut() {
            if let Some(shutdown) = shutdown_slot.take() {
                let _ = shutdown.send(());
            }
        }
    }
}

/// Launch the desktop application.
pub fn run() {
    let lifecycle = Arc::new(BffLifecycle::default());
    let setup_lifecycle = Arc::clone(&lifecycle);
    let app = tauri::Builder::default()
        .setup(move |app| setup_desktop(app, &setup_lifecycle))
        .build(tauri::generate_context!())
        .expect("failed to build the Ephemeral Sandbox desktop host");

    let event_lifecycle = Arc::clone(&lifecycle);
    let exit_code = app.run_return(move |app_handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { .. },
            ..
        } if label == MAIN_WINDOW_LABEL => {
            event_lifecycle.request_shutdown();
            app_handle.exit(0);
        }
        RunEvent::ExitRequested { .. } => event_lifecycle.request_shutdown(),
        _ => {}
    });

    lifecycle.request_shutdown();
    if let Err(error) = lifecycle.wait_for_server() {
        eprintln!("Ephemeral Sandbox shutdown error: {error}");
    }
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

fn setup_desktop<R: tauri::Runtime>(
    app: &mut tauri::App<R>,
    lifecycle: &BffLifecycle,
) -> SetupResult<()> {
    let resource_path = app
        .path()
        .resolve(WEB_RESOURCE_DIR, BaseDirectory::Resource)?;
    let web_dist = validate_web_dist(&resource_path)?;
    let StartedBff {
        address,
        bootstrap_url,
        shutdown,
        server_task,
    } = start_bff(web_dist)?;
    lifecycle.install(shutdown, server_task)?;

    WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::External(bootstrap_url))
        .title("Ephemeral Sandbox")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .on_navigation(move |url| is_allowed_navigation(url, address))
        .build()?;
    Ok(())
}

fn start_bff(web_dist: PathBuf) -> SetupResult<StartedBff> {
    let overrides = ConsoleConfigOverrides {
        bind: Some(LOOPBACK_BIND.to_owned()),
        assets_dir: Some(web_dist),
        ..ConsoleConfigOverrides::default()
    };
    let mut config = ConsoleConfig::discover(overrides)
        .map_err(|error| io::Error::other(format!("desktop BFF configuration failed: {error}")))?;
    let listener = StdTcpListener::bind(config.bind.as_str())?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    ensure_ephemeral_loopback(address)?;
    config.bind = address.to_string();

    let nonce = random_secret();
    let session_token = random_secret();
    let auth = DesktopSessionAuth::new(&address.to_string(), nonce.clone(), session_token)
        .map_err(io::Error::other)?;
    let state = AppState::new(config).with_desktop_auth(auth);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server_task = tauri::async_runtime::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener)?;
        server::serve_until(listener, state, async move {
            let _ = shutdown_rx.await;
        })
        .await
    });
    let bootstrap_url = Url::parse(&format!(
        "http://{address}{DESKTOP_BOOTSTRAP_PATH}?nonce={nonce}"
    ))?;
    Ok(StartedBff {
        address,
        bootstrap_url,
        shutdown: shutdown_tx,
        server_task,
    })
}

fn validate_web_dist(path: &Path) -> io::Result<PathBuf> {
    if !path.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "packaged web resource directory is missing: {}",
                path.display()
            ),
        ));
    }
    let index = path.join("index.html");
    if !index.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("packaged web entry point is missing: {}", index.display()),
        ));
    }
    path.canonicalize()
}

fn ensure_ephemeral_loopback(address: SocketAddr) -> io::Result<()> {
    if address.ip() == IpAddr::V4(Ipv4Addr::LOCALHOST) && address.port() != 0 {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::AddrNotAvailable,
            format!("desktop BFF resolved an invalid listener address: {address}"),
        ))
    }
}

fn is_allowed_navigation(url: &Url, address: SocketAddr) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(address.port())
}

fn random_secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_secrets_are_high_entropy_cookie_and_url_values() {
        let first = random_secret();
        let second = random_secret();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_alphanumeric()));
        assert_ne!(first, second);
    }

    #[test]
    fn navigation_is_confined_to_the_bound_bff_origin() {
        let address: SocketAddr = "127.0.0.1:49152".parse().expect("test address");
        for allowed in [
            "http://127.0.0.1:49152/",
            "http://127.0.0.1:49152/api/catalog",
            "http://127.0.0.1:49152/s/eos-1/",
        ] {
            let url = Url::parse(allowed).expect("allowed URL");
            assert!(is_allowed_navigation(&url, address), "{url}");
        }
        for rejected in [
            "http://127.0.0.1:49153/",
            "http://localhost:49152/",
            "https://127.0.0.1:49152/",
            "https://example.com/",
        ] {
            let url = Url::parse(rejected).expect("rejected URL");
            assert!(!is_allowed_navigation(&url, address), "{url}");
        }
    }

    #[test]
    fn packaged_resource_validation_requires_the_vite_entry_point() {
        let root = std::env::temp_dir().join(format!("ephemeral-web-dist-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create test resource directory");
        assert!(validate_web_dist(&root).is_err());
        std::fs::write(root.join("index.html"), "<!doctype html>").expect("write test entry point");
        let resolved = validate_web_dist(&root).expect("valid web resource");
        assert_eq!(resolved, root.canonicalize().expect("canonical test path"));
        std::fs::remove_dir_all(root).expect("remove test resource directory");
    }

    #[test]
    fn product_and_asset_metadata_stay_aligned_across_web_and_desktop() {
        const PRODUCT_NAME: &str = "Ephemeral Sandbox";

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        let package: serde_json::Value =
            serde_json::from_str(include_str!("../../../web/package.json"))
                .expect("valid web package metadata");
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../shared/assets/manifest.json"))
                .expect("valid asset manifest");
        let web_index = include_str!("../../../web/index.html");
        let web_brand = include_str!("../../../web/src/config/brand.ts");

        assert_eq!(config["productName"], PRODUCT_NAME);
        assert_eq!(manifest["product"], PRODUCT_NAME);
        assert_eq!(package["name"], "ephemeral-sandbox-console");
        assert!(web_index.contains(&format!("<title>{PRODUCT_NAME}</title>")));
        assert!(web_brand.contains(&format!("PRODUCT_NAME = \"{PRODUCT_NAME}\"")));

        let source_hash = manifest["source"]["sha256"]
            .as_str()
            .expect("manifest source hash is text");
        assert!(web_brand.contains(source_hash));
        for format in ["png", "webp"] {
            let path = manifest["derivatives"]["web"][format]["path"]
                .as_str()
                .expect("manifest web asset path is text");
            let public_url = path
                .strip_prefix("shared/public")
                .expect("web derivative is under shared/public");
            assert!(
                web_brand.contains(public_url),
                "brand config is missing {public_url}"
            );
        }

        assert_eq!(
            config["bundle"]["resources"]["../../web/dist/"],
            "web-dist/"
        );
        assert_eq!(config["app"]["windows"], serde_json::json!([]));
        assert_eq!(config["build"]["beforeDevCommand"]["wait"], true);

        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json"))
                .expect("valid capability");
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(capability["permissions"], serde_json::json!([]));
    }
}
