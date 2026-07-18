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
- Docker when using the local full-stack launcher or live compatibility gate

## Build and test

```sh
bin/check-boundaries
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked
cargo test --workspace --locked

cd web
npm ci
npm run test:unit
npm run build
npm run test:e2e
npm run test:a11y
npm run test:security
npm run test:visual
```

The live compatibility gate clones the immutable core revision into a temporary
directory and exercises catalog, one-shot and SSE RPC, health, files, and HTTP
and WebSocket previews against a real Docker sandbox:

```sh
bin/live-pinned-core-check
```

Build the BFF and matching production SPA into an installable directory and
platform-specific archive with:

```sh
bin/package-console
```

The bundle is written to `dist/ephemeral-sandbox-console`, with the BFF under
`bin/` and assets under `share/ephemeral-sandbox-console/`. The matching
`.tar.gz` is ready for release upload. `web/dist`, `dist/console`, and all
release bundles are generated and intentionally untracked. For a local
assets-only refresh, use `bin/package-console --assets-only`.

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
