//! Console configuration: loopback bind address, gateway endpoint and auth
//! token (via the shared operation client discovery), the SPA asset directory,
//! and the server timeouts from the optional `console` YAML section.

use std::path::PathBuf;
use std::time::Duration;

use sandbox_config::configs::validate::{require_f64_gt, require_socket_addr, ConfigFieldError};
use sandbox_operation_client::{GatewayConfig, GatewayConfigOverrides};
use serde::Deserialize;

pub const SANDBOX_CONSOLE_BIND_ENV: &str = "SANDBOX_CONSOLE_BIND";
pub const SANDBOX_CONSOLE_ASSETS_ENV: &str = "SANDBOX_CONSOLE_ASSETS";
pub const SANDBOX_CONSOLE_CLUSTER_REGISTRY_ENV: &str = "SANDBOX_CONSOLE_CLUSTER_REGISTRY";
pub const SANDBOX_CONSOLE_CONFIG_YAML_ENV: &str = "SANDBOX_CONSOLE_CONFIG_YAML";

const DEFAULT_ASSET_DIRS: &[&str] = &["dist/console", "web/dist"];

pub const DEFAULT_CONSOLE_BIND: &str = "127.0.0.1:7880";

/// Typed schema for the optional `console` section of the sandbox config.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ConsoleSection {
    pub bind_addr: String,
    pub rpc_timeout_s: f64,
    pub health_probe_timeout_s: f64,
    pub proxy_connect_timeout_s: f64,
    pub proxy_response_timeout_s: f64,
    pub endpoint_resolve_timeout_s: f64,
    pub endpoint_cache_ttl_s: f64,
}

impl Default for ConsoleSection {
    fn default() -> Self {
        Self {
            bind_addr: DEFAULT_CONSOLE_BIND.to_owned(),
            rpc_timeout_s: 120.0,
            health_probe_timeout_s: 2.0,
            proxy_connect_timeout_s: 10.0,
            proxy_response_timeout_s: 30.0,
            endpoint_resolve_timeout_s: 5.0,
            endpoint_cache_ttl_s: 3.0,
        }
    }
}

impl ConsoleSection {
    /// Validate semantic constraints that YAML deserialization cannot express.
    ///
    /// # Errors
    /// Returns an error when a field violates console policy.
    pub fn validate(&self) -> Result<(), ConfigFieldError> {
        require_socket_addr(&self.bind_addr, "console.bind_addr")?;
        require_f64_gt(self.rpc_timeout_s, 0.0, "console.rpc_timeout_s")?;
        require_f64_gt(
            self.health_probe_timeout_s,
            0.0,
            "console.health_probe_timeout_s",
        )?;
        require_f64_gt(
            self.proxy_connect_timeout_s,
            0.0,
            "console.proxy_connect_timeout_s",
        )?;
        require_f64_gt(
            self.proxy_response_timeout_s,
            0.0,
            "console.proxy_response_timeout_s",
        )?;
        require_f64_gt(
            self.endpoint_resolve_timeout_s,
            0.0,
            "console.endpoint_resolve_timeout_s",
        )?;
        require_f64_gt(
            self.endpoint_cache_ttl_s,
            0.0,
            "console.endpoint_cache_ttl_s",
        )
    }
}

#[derive(Debug, Clone)]
pub struct ConsoleConfig {
    pub bind: String,
    pub gateway: GatewayConfig,
    pub assets_dir: Option<PathBuf>,
    pub cluster_registry_path: PathBuf,
    pub rpc_timeout: Duration,
    pub health_probe_timeout: Duration,
    pub proxy_connect_timeout: Duration,
    pub proxy_response_timeout: Duration,
    pub endpoint_resolve_timeout: Duration,
    pub endpoint_cache_ttl: Duration,
}

#[derive(Debug, Clone, Default)]
pub struct ConsoleConfigOverrides {
    pub bind: Option<String>,
    pub assets_dir: Option<PathBuf>,
    pub cluster_registry_path: Option<PathBuf>,
    pub rpc_timeout_ms: Option<u64>,
    pub config_yaml: Option<PathBuf>,
    pub gateway: GatewayConfigOverrides,
}

impl ConsoleConfig {
    /// Discover the console config from explicit overrides, environment, and
    /// the optional `console` section of the YAML named by `--config-yaml` /
    /// `SANDBOX_CONSOLE_CONFIG_YAML`. Flag/env overrides outrank YAML.
    ///
    /// # Errors
    /// Returns an error when the gateway socket or auth token is invalid, or
    /// when the YAML document fails to load or validate.
    pub fn discover(overrides: ConsoleConfigOverrides) -> Result<Self, Box<dyn std::error::Error>> {
        let yaml_path = overrides
            .config_yaml
            .clone()
            .or_else(|| std::env::var_os(SANDBOX_CONSOLE_CONFIG_YAML_ENV).map(PathBuf::from));
        let section = load_console_section(yaml_path)?;
        let gateway = GatewayConfig::discover(overrides.gateway.clone())?;
        Ok(Self::from_sources(
            overrides,
            std::env::var(SANDBOX_CONSOLE_BIND_ENV).ok(),
            std::env::var_os(SANDBOX_CONSOLE_ASSETS_ENV).map(PathBuf::from),
            std::env::var_os(SANDBOX_CONSOLE_CLUSTER_REGISTRY_ENV).map(PathBuf::from),
            section,
            gateway,
        ))
    }

    /// Resolve the effective config from already-gathered sources with
    /// flag > env > YAML section > default precedence. `section` must be
    /// validated; the gateway endpoint resolves separately via
    /// [`GatewayConfig::discover`].
    #[must_use]
    pub fn from_sources(
        overrides: ConsoleConfigOverrides,
        env_bind: Option<String>,
        env_assets: Option<PathBuf>,
        env_cluster_registry: Option<PathBuf>,
        section: ConsoleSection,
        gateway: GatewayConfig,
    ) -> Self {
        let bind = overrides
            .bind
            .or(env_bind)
            .unwrap_or_else(|| section.bind_addr.clone());
        let assets_dir = overrides
            .assets_dir
            .or(env_assets)
            .or_else(default_assets_dir);
        let cluster_registry_path = overrides
            .cluster_registry_path
            .or(env_cluster_registry)
            .unwrap_or_else(default_cluster_registry_path);
        let rpc_timeout = overrides.rpc_timeout_ms.map_or_else(
            || Duration::from_secs_f64(section.rpc_timeout_s),
            Duration::from_millis,
        );
        Self {
            bind,
            gateway,
            assets_dir,
            cluster_registry_path,
            rpc_timeout,
            health_probe_timeout: Duration::from_secs_f64(section.health_probe_timeout_s),
            proxy_connect_timeout: Duration::from_secs_f64(section.proxy_connect_timeout_s),
            proxy_response_timeout: Duration::from_secs_f64(section.proxy_response_timeout_s),
            endpoint_resolve_timeout: Duration::from_secs_f64(section.endpoint_resolve_timeout_s),
            endpoint_cache_ttl: Duration::from_secs_f64(section.endpoint_cache_ttl_s),
        }
    }
}

fn load_console_section(
    path: Option<PathBuf>,
) -> Result<ConsoleSection, Box<dyn std::error::Error>> {
    let Some(path) = path else {
        return Ok(ConsoleSection::default());
    };
    let document = sandbox_config::load_path(&path)?;
    let section = match document.section::<ConsoleSection>("console") {
        Ok(section) => section,
        Err(sandbox_config::ConfigError::MissingSection { .. }) => ConsoleSection::default(),
        Err(error) => return Err(error.into()),
    };
    section.validate()?;
    Ok(section)
}

fn default_assets_dir() -> Option<PathBuf> {
    DEFAULT_ASSET_DIRS
        .iter()
        .map(PathBuf::from)
        .find(|dir| dir.join("index.html").is_file())
}

fn default_cluster_registry_path() -> PathBuf {
    if let Some(state_home) = std::env::var_os("XDG_STATE_HOME") {
        return PathBuf::from(state_home)
            .join("ephemeral-sandbox-console")
            .join("sandbox-clusters.json");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join(".local")
            .join("state")
            .join("ephemeral-sandbox-console")
            .join("sandbox-clusters.json");
    }
    std::env::temp_dir()
        .join("ephemeral-sandbox-console")
        .join("sandbox-clusters.json")
}
