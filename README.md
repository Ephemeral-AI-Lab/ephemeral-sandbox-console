# Ephemeral Sandbox Console

Ephemeral Sandbox Console is the browser client and trusted Rust
backend-for-frontend (BFF) for
[Ephemeral Sandbox](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox).
The BFF keeps gateway credentials out of browser JavaScript, serves the built
React application, validates public operations, streams RPC responses, and
enforces the HTTP and WebSocket preview boundary.

```text
browser -> web -> server -> sandbox-operation-client -> sandbox gateway
```

The repository contains:

- `server/`: the Rust BFF and its route, configuration, proxy, and security
  tests.
- `web/`: the React and Vite application, unit tests, Playwright coverage, and
  tracked visual snapshots.
- `bin/`: console-local packaging and launch helpers.
- `desktop/`: a reserved placeholder; desktop implementation is out of scope.

Core operation dependencies are fetched from one immutable Ephemeral Sandbox
Git revision recorded in `Cargo.toml` and `Cargo.lock`. A clean build does not
require a sibling core checkout.

## Requirements

- Rust from `rust-toolchain.toml`
- Node.js 24, pinned by `.node-version` and `.nvmrc`
- Docker only when using the local full-stack launcher

## Build and test

```sh
cargo fmt --check
cargo clippy --workspace --all-targets
cargo test --workspace --locked

cd web
npm ci
npm run test:unit
npm run build
npm run test:e2e
npm run test:a11y
npm run test:visual
```

Package the production SPA into `dist/console` and build the BFF with:

```sh
bin/package-console
cargo build --locked --release -p sandbox-console --bin sandbox-console
```

Both `web/dist` and `dist/console` are generated and intentionally untracked.
A release should ship the BFF binary and the matching `dist/console` tree.

## Run against a gateway

The release launcher needs no core source checkout. Configure the gateway by
environment:

```sh
export SANDBOX_GATEWAY_SOCKET=127.0.0.1:7878
export SANDBOX_GATEWAY_AUTH_TOKEN=TOKEN
bin/start-sandbox-console --bind 127.0.0.1:7880
```

The same settings may be passed as BFF flags:

```sh
bin/start-sandbox-console \
  --bind 127.0.0.1:7880 \
  --gateway-socket 127.0.0.1:7878 \
  --gateway-auth-token TOKEN \
  --assets dist/console
```

`SANDBOX_CONSOLE_BIN` may name an installed BFF binary and
`SANDBOX_CONSOLE_ASSETS` may name an installed asset directory. Environment
tokens are preferable to command-line tokens because command-line arguments can
be visible to other local processes.

## Local full stack

For source development, point the stack launcher at an Ephemeral Sandbox
checkout or place that checkout beside this repository:

```sh
EPHEMERAL_SANDBOX_ROOT=/path/to/ephemeral-sandbox \
  bin/start-sandbox-console-stack
```

The stack launcher starts the core Docker gateway, packages this repository's
SPA, builds the BFF, loads the gateway token through the core checkout's helper,
and starts the console on `127.0.0.1:7880`. Use `--skip-gateway` with
`SANDBOX_GATEWAY_SOCKET` and `SANDBOX_GATEWAY_AUTH_TOKEN` to attach to an
already-running gateway without a core checkout.

See [`server/README.md`](server/README.md) for the BFF routes and configuration
precedence, and [`MIGRATION_SPEC.md`](MIGRATION_SPEC.md) for the repository
boundary and acceptance gates.
