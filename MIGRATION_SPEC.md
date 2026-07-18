# Ephemeral Sandbox Console Extraction Specification

Status: Proposed  
Source repository: `ephemeral-sandbox`  
Target repository: `ephemeral-sandbox-console`

## 1. Objective

Move ownership of the web console and all web-console-specific hosting,
configuration, build, test, and packaging code from `ephemeral-sandbox` into
`ephemeral-sandbox-console`.

After the migration:

- `ephemeral-sandbox` is a headless sandbox platform with no console or web UI
  build/runtime dependency.
- `ephemeral-sandbox-console` owns the React application and its trusted Rust
  backend-for-frontend (BFF).
- Dependencies point in one direction: `ephemeral-sandbox-console` depends on the
  public client-facing crates in `ephemeral-sandbox`; the core repository never
  depends on the console repository.
- The existing console behavior and security boundaries remain unchanged.
- `desktop/` exists only as a reserved location. Desktop architecture and
  implementation are outside this migration.

“UI-free” means that the core repository contains no UI source, UI server,
Node toolchain, UI packaging, UI configuration, or UI tests. A documentation
link to the external console project is allowed.

## 2. Architectural boundary

The current `sandbox-console` Rust crate is not the visual UI. It is the web
application's trusted BFF. It keeps gateway credentials out of the browser,
serves the built application, translates browser requests into gateway client
operations, streams RPC responses, and enforces preview proxy security.

That code belongs with the web client because its public routes, asset serving,
same-origin behavior, and preview policies are client-hosting concerns. The
gateway, operation protocol, sandbox lifecycle, and daemon capabilities remain
core concerns.

```text
Browser
  -> ephemeral-sandbox-console/web
  -> ephemeral-sandbox-console/server (HTTP, SSE, assets, preview proxy)
  -> sandbox-operation-client
  -> ephemeral-sandbox gateway
  -> manager / daemon / runtime
```

The browser must not call the gateway directly and must never receive the
gateway authentication token.

## 3. Target repository layout

The initial extraction uses a simple flat layout and avoids a speculative
desktop abstraction:

```text
ephemeral-sandbox-console/
├── Cargo.toml
├── Cargo.lock
├── MIGRATION_SPEC.md
├── README.md
├── LICENSE
├── rust-toolchain.toml
├── bin/
│   ├── start-sandbox-console
│   └── start-sandbox-console-stack
├── server/                   # Rust web BFF, currently crates/sandbox-console
├── web/                      # React/Vite console, currently web/console
├── desktop/                  # Reserved placeholder; no implementation yet
└── .github/workflows/
```

The directory name `server/` distinguishes the Rust BFF from the console
product and repository. Extraction must not combine this path change with a
redesign of the BFF.

## 4. Ownership mapping

### 4.1 Move to `ephemeral-sandbox-console`

| Current source | Target | Notes |
| --- | --- | --- |
| `crates/sandbox-console/**` | `server/**` | Preserve history; update workspace paths. |
| `web/console/**` | `web/**` | Move tracked source, tests, snapshots, and public assets only. |
| `bin/start-sandbox-console` | `bin/start-sandbox-console` | Remove assumptions that the gateway helper is in the same repository. |
| `bin/start-sandbox-console-stack` | `bin/start-sandbox-console-stack` | Teach it how to locate a sibling or configured core checkout. |
| Console configuration schema and tests | `server/src/config.rs` and server tests | Console repository owns typed console settings and defaults. |
| Console packaging behavior in `xtask` | Console-local scripts or tasks | Move the behavior; do not copy unrelated core `xtask` code. |
| Console-specific documentation and architecture checks | Console docs and CI | Preserve relevant security and route invariants. |

Generated and ignored artifacts must not be migrated, including
`node_modules/`, Vite output, Playwright results, root `dist/console`, and Cargo
build output.

### 4.2 Keep in `ephemeral-sandbox`

- `sandbox-operation-contract`
- `sandbox-operation-catalog`
- `sandbox-operation-client`
- `sandbox-operation-protocol`
- gateway authentication and the gateway token helper
- gateway, manager, daemon, runtime, and observability implementations
- daemon `/health`, `/files/list`, and forwarding capabilities
- resource metrics, activity revision, workspace roots, and sandbox records
- generic configuration loading primitives, if the console continues to consume
  them
- project-level branding used by the core README

The preview BFF implementation moves, but the daemon-side forwarding capability
that it calls remains in core.

### 4.3 Remove or revise in `ephemeral-sandbox`

- Remove `sandbox-console` from the Cargo workspace and workspace dependencies.
- Remove the console crate, React application, and console launch scripts.
- Remove the typed console configuration module and its core tests.
- Remove `package-console` and console-only help from `xtask`.
- Remove console-specific architecture policies, source-boundary entries, and
  proof rules; recreate relevant rules in the console repository.
- Remove Node/Vite/Playwright-specific ignore and CI configuration that has no
  remaining core consumer.
- Update the root README and maintainer architecture documentation to point to
  the external console repository.
- Rewrite comments such as “Console picker” in client-neutral terms where the
  underlying core capability remains.
- Regenerate `Cargo.lock` after workspace removal.

## 5. Core dependency contract

The console repository consumes the core operation crates through Git
dependencies pinned to one exact core revision. All core crates must use the
same revision, and `Cargo.lock` must be committed.

Illustrative configuration:

```toml
[dependencies]
sandbox-operation-contract = { git = "<core-repository-url>", rev = "<core-commit>" }
sandbox-operation-client = { git = "<core-repository-url>", rev = "<core-commit>" }
sandbox-operation-catalog = { git = "<core-repository-url>", rev = "<core-commit>", features = ["manager", "runtime", "observability"] }
```

A sibling `path = "../ephemeral-sandbox/..."` dependency may be offered as an
explicit local development override, but it must not be the canonical build or
CI configuration. The console repository must build from a clean checkout
without a sibling source tree.

The operation contract, catalog, and client form the supported client-facing
SDK boundary. The core repository should document compatibility expectations
for these crates before console removal.

## 6. Functional requirements

The extracted console must preserve the existing behavior of:

- `GET /api/catalog`
- `POST /api/rpc`, including one-shot and SSE responses
- sandbox health lookup
- sandbox file listing
- static application assets and SPA fallback
- sandbox HTTP preview proxying
- WebSocket upgrade and tunneling for previews
- configuration discovery and command-line overrides
- graceful startup and shutdown behavior

Route names and response shapes must not change as part of extraction. Any API
redesign is a separate change after the repositories have been decoupled.

## 7. Security invariants

The migration is incomplete unless all existing BFF security behavior is
preserved and tested:

- Gateway credentials stay server-side.
- The server binds to loopback by default unless explicitly configured.
- RPC requests are validated against the public operation protocol.
- Preview requests cannot forward console cookies, authorization credentials,
  origin credentials, or spoofed forwarding headers into a sandbox.
- Preview responses cannot set console cookies or broaden service-worker scope.
- Preview redirects remain under the selected sandbox preview route.
- Preview pages retain the current opaque-origin, CSP, permissions, referrer,
  and content-type protections.
- WebSocket previews follow the same routing and credential isolation rules as
  HTTP previews.

Security tests currently located beside `sandbox-console` move with the BFF and
remain required CI gates.

## 8. Migration sequence

### Phase 0: establish the cutover baseline

1. Reconcile the source migration branch with `main`.
2. Preserve or finish unrelated working-tree changes before extraction.
3. Choose and record one exact core cutover commit or tag.
4. Make the existing console test suites green, or document and approve every
   pre-existing failure before comparing migration results.
5. Use a supported Node release in local development and CI.

Known baseline issues observed before this specification was written:

- `cargo test -p sandbox-console` has one compatibility-catalog fixture
  mismatch while the other console tests pass.
- The web unit-test runner fails under Node `22.7.0`; the package declares
  `>=22.12.0 || >=24.0.0`. The production Vite build succeeds with a version
  warning. The target CI should pin Node 24.

These are baseline issues, not acceptable post-migration regressions.

### Phase 1: extract tracked history

1. Create a fresh filtered clone from the selected source commit.
2. Select the console crate, web console, launch scripts, and console-specific
   configuration history.
3. Move the selected paths into the target layout.
4. Add new root workspace, README, license, toolchain, and CI files in the
   console repository.
5. Do not rewrite the active source repository's history. Historical console
   files may remain visible in old core commits.

Use a history-filtering tool in a fresh clone rather than copying the current
working directories. A direct recursive copy would accidentally include large
ignored build and dependency directories.

### Phase 2: make the console repository independent

1. Replace core workspace/path dependencies with exact Git revisions.
2. Move the console configuration schema into the BFF.
3. Remove the BFF test's dependency on the core CLI compatibility fixture;
   store a console-owned snapshot or test public catalog invariants instead.
4. Make asset paths relative to the console repository and its packaged output.
5. Update launch scripts to accept `EPHEMERAL_SANDBOX_ROOT` or locate a sibling
   checkout for local stack development.
6. Let release and CI builds consume installed/published core binaries rather
   than assuming a sibling source checkout.
7. Add Rust, web unit, build, browser, accessibility, and security CI jobs.

### Phase 3: shadow validation

Run the extracted console against the pinned core while the original console
still exists in the core repository. Compare routes, catalog contents, RPC
streaming, file listing, previews, and security behavior.

No source deletion occurs until the extracted application passes the acceptance
gates in Section 10.

### Phase 4: remove console ownership from core

1. Delete the source paths listed in Section 4.1 from the core repository.
2. Apply the workspace, config, documentation, architecture-check, ignore-file,
   and lockfile cleanup listed in Section 4.3.
3. Run the complete core acceptance suite.
4. Update the console's pinned core revision to the cleanup commit and rerun the
   console acceptance suite.

Recommended cross-repository commit order:

1. Core compatibility commit: stabilize client-facing APIs without deleting
   the existing console.
2. Console extraction commit: pin that core revision and pass console validation.
3. Core cleanup commit: remove console ownership.
4. Console pin-update commit: consume and validate the cleaned core revision.

At every point, at least one working console implementation remains available.

## 9. Launch and packaging contract

The console repository owns compilation and packaging of both the Rust BFF and
web assets. A release artifact must contain compatible versions of both.

For local full-stack development, the console launcher may start or call
binaries from a configured core checkout. For release use, it should accept gateway
endpoint and token configuration without needing core source files.

The source tree must not be used as the runtime asset directory in a packaged
release. Asset discovery must work from the installed artifact layout.

## 10. Acceptance gates

### Console repository

- `cargo fmt --check` passes.
- `cargo clippy --workspace --all-targets` passes with the agreed warning
  policy.
- `cargo test --workspace` passes.
- A clean `npm ci` using pinned Node 24 passes.
- Web unit tests pass.
- The production web build passes.
- Playwright browser, visual, accessibility, and security tests pass.
- A live smoke test against the pinned core revision covers catalog, one-shot
  RPC, SSE RPC, health, files, HTTP previews, and WebSocket previews.
- No test or build requires a sibling `ephemeral-sandbox` checkout.
- No gateway credential is exposed to browser JavaScript or web assets.

### Core repository

- `cargo metadata` contains no `sandbox-console` package.
- Cargo format, check, Clippy, unit, integration, and architecture tests pass.
- No Node, Vite, Vitest, or Playwright toolchain is required.
- No console asset build or `package-console` task remains.
- No console configuration schema remains.
- A repository search finds no console implementation references except an
  explicit allowlist for external documentation links.
- Core gateway and daemon HTTP/forwarding tests continue to pass independently
  of the console repository.

## 11. Rollback

Until Phase 4, rollback means continuing to use the console in the core
repository. After Phase 4, rollback should revert the core cleanup commit and
return the console pin to the last validated compatible core revision.

Do not solve rollback by force-pushing or rewriting shared repository history.

## 12. Explicit non-goals

- Designing or implementing the desktop application
- Selecting a desktop framework
- Sharing frontend components with desktop
- Redesigning the gateway or operation protocol
- Changing public console routes or response formats
- Reworking preview security policy
- Publishing the core crates to a package registry
- Removing historical UI files from old core commits
- Flattening or broadly refactoring existing console behavior during extraction

## 13. Decisions recorded by this specification

1. The Rust `sandbox-console` BFF moves with the web application.
2. Core operation contract, catalog, and client crates stay in
   `ephemeral-sandbox`.
3. Repository dependencies remain one-way from console to core.
4. Canonical builds use one exact Git revision, not sibling path dependencies.
5. Migration preserves behavior first; renaming and refactoring happen later.
6. Core history is not rewritten merely to erase old UI files.
7. `desktop/` is reserved but intentionally has no architecture yet.
