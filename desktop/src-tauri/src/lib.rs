//! Thin Tauri host for the Ephemeral Sandbox web console.
//!
//! The WebView loads the same production Vite files as the browser build from
//! the existing Rust BFF. Tauri owns only resource resolution, window
//! lifecycle, and graceful server cancellation.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read};
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
const GATEWAY_AUTH_TOKEN_ENV: &str = "SANDBOX_GATEWAY_AUTH_TOKEN";
const GATEWAY_TOKEN_FILE_ENV: &str = "SANDBOX_GATEWAY_TOKEN_FILE";
const DEFAULT_GATEWAY_TOKEN_FILE: &str = ".ephemeral-sandbox/gateway.token";
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
    let gateway_auth_token = discover_desktop_gateway_auth_token(
        std::env::var_os(GATEWAY_AUTH_TOKEN_ENV),
        std::env::var_os(GATEWAY_TOKEN_FILE_ENV),
        std::env::var_os("HOME"),
    )?;
    start_bff_with_gateway_auth_token(web_dist, gateway_auth_token)
}

fn start_bff_with_gateway_auth_token(
    web_dist: PathBuf,
    gateway_auth_token: Option<String>,
) -> SetupResult<StartedBff> {
    let mut overrides = ConsoleConfigOverrides {
        bind: Some(LOOPBACK_BIND.to_owned()),
        assets_dir: Some(web_dist),
        ..ConsoleConfigOverrides::default()
    };
    overrides.gateway.gateway_auth_token = gateway_auth_token;
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

fn discover_desktop_gateway_auth_token(
    explicit_auth_token: Option<OsString>,
    token_file: Option<OsString>,
    home: Option<OsString>,
) -> io::Result<Option<String>> {
    if let Some(token) = explicit_auth_token {
        return Ok(Some(token.to_string_lossy().into_owned()));
    }

    let token_path = token_file
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            home.filter(|path| !path.is_empty())
                .map(PathBuf::from)
                .map(|path| path.join(DEFAULT_GATEWAY_TOKEN_FILE))
        });
    let Some(token_path) = token_path else {
        return Ok(None);
    };

    read_private_gateway_token(&token_path)
}

fn read_private_gateway_token(path: &Path) -> io::Result<Option<String>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(io::Error::new(
                error.kind(),
                format!(
                    "failed to open gateway token file {}: {error}",
                    path.display()
                ),
            ));
        }
    };
    let metadata = file.metadata().map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "failed to inspect gateway token file {}: {error}",
                path.display()
            ),
        )
    })?;
    validate_private_gateway_token_file(path, &metadata)?;

    let mut contents = String::new();
    file.read_to_string(&mut contents).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "failed to read gateway token file {}: {error}",
                path.display()
            ),
        )
    })?;
    let mut lines = contents.lines();
    let token = lines.next().filter(|line| !line.trim().is_empty());
    if token.is_none() || lines.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "gateway token file must contain exactly one non-empty line: {}",
                path.display()
            ),
        ));
    }
    Ok(token.map(str::to_owned))
}

#[cfg(unix)]
fn validate_private_gateway_token_file(
    path: &Path,
    metadata: &std::fs::Metadata,
) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "gateway token path is not a regular file: {}",
                path.display()
            ),
        ));
    }
    let mode = metadata.permissions().mode();
    if mode & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "gateway token file must not be accessible by group or other users: {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_private_gateway_token_file(
    path: &Path,
    metadata: &std::fs::Metadata,
) -> io::Result<()> {
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "gateway token path is not a regular file: {}",
                path.display()
            ),
        ));
    }
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!(
            "gateway token file permissions cannot be verified on this platform: {}",
            path.display()
        ),
    ))
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

    #[cfg(unix)]
    fn write_private_token(path: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::create_dir_all(path.parent().expect("token parent"))
            .expect("create token directory");
        std::fs::write(path, contents).expect("write gateway token");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .expect("secure gateway token");
    }

    #[cfg(unix)]
    #[test]
    fn desktop_gateway_token_discovery_loads_the_private_default_file() {
        let home = std::env::temp_dir().join(format!("ephemeral-desktop-home-{}", Uuid::new_v4()));
        let token_path = home.join(".ephemeral-sandbox/gateway.token");
        write_private_token(&token_path, "desktop-token\n");

        let token = discover_desktop_gateway_auth_token(None, None, Some(home.clone().into()))
            .expect("discover gateway token");

        assert_eq!(token.as_deref(), Some("desktop-token"));
        std::fs::remove_dir_all(home).expect("remove test home");
    }

    #[cfg(unix)]
    #[test]
    fn desktop_gateway_token_discovery_honors_source_precedence() {
        use std::os::unix::fs::PermissionsExt;

        let root =
            std::env::temp_dir().join(format!("ephemeral-desktop-tokens-{}", Uuid::new_v4()));
        let default_path = root.join(".ephemeral-sandbox/gateway.token");
        let configured_path = root.join("service/gateway.token");
        write_private_token(&default_path, "default-token\n");
        write_private_token(&configured_path, "configured-token");

        let configured = discover_desktop_gateway_auth_token(
            None,
            Some(configured_path.clone().into()),
            Some(root.clone().into()),
        )
        .expect("configured token file");
        assert_eq!(configured.as_deref(), Some("configured-token"));

        std::fs::set_permissions(&configured_path, std::fs::Permissions::from_mode(0o644))
            .expect("make configured token insecure");
        let explicit = discover_desktop_gateway_auth_token(
            Some("explicit-token".into()),
            Some(configured_path.into()),
            Some(root.clone().into()),
        )
        .expect("explicit token bypasses files");
        assert_eq!(explicit.as_deref(), Some("explicit-token"));

        std::fs::remove_dir_all(root).expect("remove token fixtures");
    }

    #[cfg(unix)]
    #[test]
    fn desktop_gateway_token_discovery_allows_a_missing_file_only() {
        let root = std::env::temp_dir().join(format!("ephemeral-missing-token-{}", Uuid::new_v4()));
        let missing = root.join("gateway.token");

        let token =
            discover_desktop_gateway_auth_token(None, Some(missing.into()), Some(root.into()))
                .expect("missing token file falls through");

        assert!(token.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn desktop_gateway_token_discovery_rejects_non_private_or_non_regular_files() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("ephemeral-invalid-token-{}", Uuid::new_v4()));
        let insecure = root.join("insecure.token");
        write_private_token(&insecure, "token\n");
        std::fs::set_permissions(&insecure, std::fs::Permissions::from_mode(0o640))
            .expect("make token group-readable");
        let error = read_private_gateway_token(&insecure).expect_err("reject insecure token file");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);

        let directory = root.join("directory.token");
        std::fs::create_dir(&directory).expect("create non-regular token path");
        let error = read_private_gateway_token(&directory).expect_err("reject token directory");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        std::fs::remove_dir_all(root).expect("remove invalid token fixtures");
    }

    #[cfg(unix)]
    #[test]
    fn desktop_gateway_token_discovery_requires_one_non_empty_line() {
        let root = std::env::temp_dir().join(format!("ephemeral-token-lines-{}", Uuid::new_v4()));
        let token_path = root.join("gateway.token");

        for contents in ["", "\n", " \n", "first\nsecond\n", "first\n\n"] {
            write_private_token(&token_path, contents);
            let error = read_private_gateway_token(&token_path)
                .expect_err("reject malformed gateway token file");
            assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{contents:?}");
        }

        std::fs::remove_dir_all(root).expect("remove malformed token fixtures");
    }

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
    fn desktop_lifecycle_cancels_the_in_process_bff() {
        let root = std::env::temp_dir().join(format!("ephemeral-bff-assets-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create test resource directory");
        std::fs::write(root.join("index.html"), "<!doctype html>").expect("write test entry point");

        let StartedBff {
            address,
            bootstrap_url: _,
            shutdown,
            server_task,
        } = start_bff_with_gateway_auth_token(root.clone(), Some("test-gateway-token".to_owned()))
            .expect("start desktop BFF");
        let lifecycle = BffLifecycle::default();
        lifecycle
            .install(shutdown, server_task)
            .expect("install desktop BFF lifecycle");
        lifecycle.request_shutdown();
        lifecycle
            .wait_for_server()
            .expect("desktop BFF exits cleanly");

        assert!(
            std::net::TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_err()
        );
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
