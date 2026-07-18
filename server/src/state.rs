//! Shared per-request state: the gateway client, the endpoint-resolution
//! cache, and the resolved console configuration every route handler reads.

use sandbox_operation_client::GatewayClient;

use crate::assets::AssetCachePolicy;
use crate::auth::DesktopSessionAuth;
use crate::config::ConsoleConfig;
use crate::endpoint::EndpointCache;

#[derive(Debug)]
pub struct AppState {
    pub gateway: GatewayClient,
    pub endpoints: EndpointCache,
    pub config: ConsoleConfig,
    pub desktop_auth: Option<DesktopSessionAuth>,
    pub(crate) asset_cache: AssetCachePolicy,
}

impl AppState {
    #[must_use]
    pub fn new(config: ConsoleConfig) -> Self {
        let asset_cache = AssetCachePolicy::load(config.assets_dir.as_deref());
        let gateway = GatewayClient::new(
            config.gateway.gateway_socket_path.to_string_lossy(),
            config.gateway.gateway_auth_token.clone(),
        );
        Self {
            gateway,
            endpoints: EndpointCache::new(config.endpoint_cache_ttl),
            config,
            desktop_auth: None,
            asset_cache,
        }
    }

    #[must_use]
    pub fn with_desktop_auth(mut self, auth: DesktopSessionAuth) -> Self {
        self.desktop_auth = Some(auth);
        self
    }
}
