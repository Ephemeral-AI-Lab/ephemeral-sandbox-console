use std::path::PathBuf;
use std::time::Duration;

use sandbox_console::config::{ConsoleConfig, ConsoleConfigOverrides, ConsoleSection};
use sandbox_operation_client::GatewayConfig;

fn stub_gateway() -> GatewayConfig {
    GatewayConfig {
        gateway_socket_path: PathBuf::from("127.0.0.1:7878"),
        gateway_auth_token: Some("token".to_owned()),
    }
}

fn yaml_section() -> ConsoleSection {
    ConsoleSection {
        bind_addr: "127.0.0.1:7991".to_owned(),
        rpc_timeout_s: 9.0,
        health_probe_timeout_s: 0.5,
        proxy_connect_timeout_s: 1.5,
        proxy_response_timeout_s: 2.5,
        endpoint_resolve_timeout_s: 3.5,
        endpoint_cache_ttl_s: 0.25,
    }
}

#[test]
fn section_defaults_preserve_shipped_policy() {
    let config = ConsoleSection::default();
    config.validate().expect("default console config is valid");
    assert_eq!(config.bind_addr, "127.0.0.1:7880");
    assert!((config.rpc_timeout_s - 120.0).abs() < f64::EPSILON);
    assert!((config.health_probe_timeout_s - 2.0).abs() < f64::EPSILON);
    assert!((config.proxy_connect_timeout_s - 10.0).abs() < f64::EPSILON);
    assert!((config.proxy_response_timeout_s - 30.0).abs() < f64::EPSILON);
    assert!((config.endpoint_resolve_timeout_s - 5.0).abs() < f64::EPSILON);
    assert!((config.endpoint_cache_ttl_s - 3.0).abs() < f64::EPSILON);
}

#[test]
fn section_overrides_deserialize() {
    let config = console_section(
        "console:\n  bind_addr: 127.0.0.1:7999\n  rpc_timeout_s: 1.5\n  endpoint_cache_ttl_s: 0.25\n",
    )
    .expect("console overrides deserialize");
    config.validate().expect("console overrides are valid");
    assert_eq!(config.bind_addr, "127.0.0.1:7999");
    assert!((config.rpc_timeout_s - 1.5).abs() < f64::EPSILON);
    assert!((config.endpoint_cache_ttl_s - 0.25).abs() < f64::EPSILON);
    assert!((config.health_probe_timeout_s - 2.0).abs() < f64::EPSILON);
}

#[test]
fn section_rejects_unknown_key() {
    let error = console_section("console:\n  bind: 127.0.0.1:1\n")
        .expect_err("unknown console key must be rejected");
    assert!(error.to_string().contains("bind"), "{error}");
}

#[test]
fn section_validation_rejects_edge_values() {
    let invalid = [
        ConsoleSection {
            bind_addr: "no-port".to_owned(),
            ..ConsoleSection::default()
        },
        ConsoleSection {
            rpc_timeout_s: 0.0,
            ..ConsoleSection::default()
        },
        ConsoleSection {
            health_probe_timeout_s: -1.0,
            ..ConsoleSection::default()
        },
        ConsoleSection {
            proxy_connect_timeout_s: 0.0,
            ..ConsoleSection::default()
        },
        ConsoleSection {
            proxy_response_timeout_s: 0.0,
            ..ConsoleSection::default()
        },
        ConsoleSection {
            endpoint_resolve_timeout_s: 0.0,
            ..ConsoleSection::default()
        },
        ConsoleSection {
            endpoint_cache_ttl_s: f64::NAN,
            ..ConsoleSection::default()
        },
    ];
    let fields = [
        "console.bind_addr",
        "console.rpc_timeout_s",
        "console.health_probe_timeout_s",
        "console.proxy_connect_timeout_s",
        "console.proxy_response_timeout_s",
        "console.endpoint_resolve_timeout_s",
        "console.endpoint_cache_ttl_s",
    ];
    for (config, field) in invalid.iter().zip(fields) {
        let error = config.validate().expect_err("config should be invalid");
        assert!(error.to_string().contains(field), "{error}");
    }
}

#[test]
fn resolve_defaults_when_no_flag_env_or_yaml() {
    let config = ConsoleConfig::from_sources(
        ConsoleConfigOverrides::default(),
        None,
        None,
        None,
        ConsoleSection::default(),
        stub_gateway(),
    );

    assert_eq!(config.bind, "127.0.0.1:7880");
    assert_eq!(config.rpc_timeout, Duration::from_secs(120));
    assert_eq!(config.health_probe_timeout, Duration::from_secs(2));
    assert_eq!(config.proxy_connect_timeout, Duration::from_secs(10));
    assert_eq!(config.proxy_response_timeout, Duration::from_secs(30));
    assert_eq!(config.endpoint_resolve_timeout, Duration::from_secs(5));
    assert_eq!(config.endpoint_cache_ttl, Duration::from_secs(3));
}

#[test]
fn resolve_yaml_section_beats_defaults() {
    let config = ConsoleConfig::from_sources(
        ConsoleConfigOverrides::default(),
        None,
        None,
        None,
        yaml_section(),
        stub_gateway(),
    );

    assert_eq!(config.bind, "127.0.0.1:7991");
    assert_eq!(config.rpc_timeout, Duration::from_secs(9));
    assert_eq!(config.health_probe_timeout, Duration::from_millis(500));
    assert_eq!(config.proxy_connect_timeout, Duration::from_millis(1500));
    assert_eq!(config.proxy_response_timeout, Duration::from_millis(2500));
    assert_eq!(config.endpoint_resolve_timeout, Duration::from_millis(3500));
    assert_eq!(config.endpoint_cache_ttl, Duration::from_millis(250));
}

#[test]
fn resolve_flag_beats_env_and_yaml() {
    let overrides = ConsoleConfigOverrides {
        bind: Some("127.0.0.1:7995".to_owned()),
        rpc_timeout_ms: Some(1234),
        ..ConsoleConfigOverrides::default()
    };
    let config = ConsoleConfig::from_sources(
        overrides,
        Some("127.0.0.1:7993".to_owned()),
        None,
        None,
        yaml_section(),
        stub_gateway(),
    );

    assert_eq!(config.bind, "127.0.0.1:7995");
    assert_eq!(config.rpc_timeout, Duration::from_millis(1234));
}

#[test]
fn resolve_env_bind_beats_yaml() {
    let config = ConsoleConfig::from_sources(
        ConsoleConfigOverrides::default(),
        Some("127.0.0.1:7993".to_owned()),
        None,
        None,
        yaml_section(),
        stub_gateway(),
    );

    assert_eq!(config.bind, "127.0.0.1:7993");
    // Env overrides only the bind; the YAML timeouts still apply.
    assert_eq!(config.rpc_timeout, Duration::from_secs(9));
}

#[test]
fn resolve_assets_flag_beats_env() {
    let config = ConsoleConfig::from_sources(
        ConsoleConfigOverrides {
            assets_dir: Some(PathBuf::from("/tmp/flag-assets")),
            ..ConsoleConfigOverrides::default()
        },
        None,
        Some(PathBuf::from("/tmp/env-assets")),
        None,
        ConsoleSection::default(),
        stub_gateway(),
    );
    assert_eq!(config.assets_dir, Some(PathBuf::from("/tmp/flag-assets")));

    let env_only = ConsoleConfig::from_sources(
        ConsoleConfigOverrides::default(),
        None,
        Some(PathBuf::from("/tmp/env-assets")),
        None,
        ConsoleSection::default(),
        stub_gateway(),
    );
    assert_eq!(env_only.assets_dir, Some(PathBuf::from("/tmp/env-assets")));
}

fn console_section(yaml: &str) -> Result<ConsoleSection, Box<dyn std::error::Error>> {
    let path = std::env::temp_dir().join(format!(
        "sandbox-console-config-{}.yml",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&path, yaml)?;
    let result = sandbox_config::load_path(&path).and_then(|document| document.section("console"));
    std::fs::remove_file(path)?;
    Ok(result?)
}
