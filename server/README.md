# sandbox-console BFF

The Rust server presents one same-origin surface for browser operations, app
previews, manager-owned readiness, file listing, and the production SPA. It is
a client peer of the core CLI adapters and sends authenticated requests through
`sandbox_operation_client::GatewayClient`.

The server validates `/api/rpc` against public catalog routes. It does not
define operation vocabulary, contact daemon RPC directly, expose the gateway
token to the browser, or depend on core applications, protocol, CLI, or MCP
implementations.

## Routes

```text
POST /api/rpc                                  one-shot operation dispatch
POST /api/rpc (Accept: text/event-stream)      SSE streaming dispatch
GET  /api/catalog                              public operation catalog
GET  /api/sandboxes/<id>/health                manager-owned readiness lookup
POST /api/sandboxes/<id>/files/list            daemon HTTP directory listing
ANY  /s/<id>/shared/<port>/...                 shared preview proxy
ANY  /s/<id>/isolated=<ws-id>/<port>/...       isolated preview proxy
GET  /*                                        SPA assets and route fallback
```

Protocol errors remain HTTP 200 responses. Invalid bodies return 400, upstream
gateway or daemon failures return 502, and timeouts return 504. Preview HTTP and
WebSocket requests retain the header, credential, redirect, service-worker,
opaque-origin, CSP, permissions, referrer, and content-type protections tested
beside this crate.

## Release use

Package the SPA and build the BFF from the repository root:

```sh
bin/package-console
cargo build --locked --release -p sandbox-console --bin sandbox-console
```

Run it without a core source checkout by supplying the gateway endpoint and
token through environment variables:

```sh
SANDBOX_GATEWAY_SOCKET=127.0.0.1:7878 \
SANDBOX_GATEWAY_AUTH_TOKEN=TOKEN \
bin/start-sandbox-console --bind 127.0.0.1:7880
```

The equivalent flags are `--gateway-socket`, `--gateway-auth-token`, and
`--assets`. The launcher detects `dist/console`, `web/dist`, and an installed
`share/ephemeral-sandbox-console` asset tree. Set `SANDBOX_CONSOLE_BIN` and
`SANDBOX_CONSOLE_ASSETS` when using a different release layout.

## Local full stack

`bin/start-sandbox-console-stack` starts the gateway from the sibling
`ephemeral-sandbox` checkout by default. Set `EPHEMERAL_SANDBOX_ROOT` when core
is elsewhere:

```sh
EPHEMERAL_SANDBOX_ROOT=/path/to/ephemeral-sandbox \
  bin/start-sandbox-console-stack
```

The local stack sources `bin/sandbox-gateway-token` from that core checkout
after starting the gateway. The release launcher never requires that helper.
With `--skip-gateway`, an explicit `SANDBOX_GATEWAY_AUTH_TOKEN` also removes the
local stack's need for a core checkout.

## Configuration

`--config-yaml` outranks `SANDBOX_CONSOLE_CONFIG_YAML` when selecting an
optional YAML `console` section. Console values use flag, environment, YAML,
then default precedence. Assets use `--assets`, `SANDBOX_CONSOLE_ASSETS`, then
detected packaged or development assets. Gateway discovery is independent and
uses `--gateway-socket` and `--gateway-auth-token`, then
`SANDBOX_GATEWAY_SOCKET` and `SANDBOX_GATEWAY_AUTH_TOKEN`, then its defaults.

The default console bind is `127.0.0.1:7880` and the default gateway endpoint is
`127.0.0.1:7878`. The default bind remains loopback because browser
authentication is out of scope.

For SPA development, run `npm run dev` in `web/`; Vite proxies `/api` and `/s`
to the BFF.
