Implement `/Users/yifanxu/Ephemeral-AI-Lab/ephemeral-sandbox-console/MIGRATION_SPEC.md`. Read it fully, plus applicable `AGENTS.md` and `CLAUDE.md`, before editing. Source: `/Users/yifanxu/Ephemeral-AI-Lab/ephemeral-sandbox`. Target: `/Users/yifanxu/Ephemeral-AI-Lab/ephemeral-sandbox-console`. Deliver a buildable console repository and a headless core repository. Desktop is out of scope; retain its placeholder README.

First record status, branches, remotes, and HEADs. Preserve unrelated user changes; never reset, overwrite, stash, commit, or delete them. Do not rebase, merge, push, force-push, or rewrite shared history without authorization. Preserve relevant history through a fresh filtered clone or equivalent safe method, never the active core checkout. Exclude `node_modules`, Cargo `target`, Vite output, Playwright results, `dist/console`, and other generated files. Keep the original console operational until extraction passes validation.

Create the target layout from the spec: root Cargo/project files, `server/` with the Rust BFF from `crates/sandbox-console`, `web/` with the React/Vite app from `web/console`, launchers, CI, license, toolchain, README, and desktop placeholder.

Move the BFF out of core without redesign. Preserve catalog/RPC routes, one-shot and SSE responses, health, files, assets/SPA, HTTP and WebSocket previews, config, and shutdown. Preserve all credential, loopback, validation, origin, header, redirect, CSP, service-worker, and opaque-origin protections and tests.

Keep the operation contract/catalog/client/protocol crates, gateway authentication/token helpers, manager, daemon, runtime, observability, and daemon health/files/forwarding in core. Move typed console config into the BFF. Replace the BFF test's core CLI fixture coupling with console-owned data or stable public-invariant tests.

Use one exact Git URL and immutable `rev` for every core operation dependency and commit `Cargo.lock`. Canonical clean builds and CI cannot require a sibling checkout; a documented local path override is optional. If no reachable immutable revision exists, do not invent one: complete safe work and report the precise blocker.

The console repository owns Rust/web build and packaging. Local stack scripts may use `EPHEMERAL_SANDBOX_ROOT`; releases accept gateway endpoint/token configuration without core sources. Pin Node v24. Add Rust fmt/Clippy/tests, clean npm install, web unit/build, browser/accessibility/security tests, and live pinned-core checks.

Proceed in stages:

1. Record baseline and candidate cutover revision; fix only migration-owned baseline issues.
2. Extract tracked history and make the target independent.
3. Shadow-test it while the original remains available.
4. Only after console gates pass, remove core workspace entries, console sources and scripts, typed config/tests, `package-console`, console-only architecture rules, Node-only setup, and stale docs/comments; regenerate the core lockfile.
5. Pin the console to the cleaned immutable core revision when available; validate both repositories.

Treat the catalog-fixture mismatch and Node 22.7 test failure documented in the spec as known baseline issues; leave migrated suites green on Node 24.

After each stage inspect diffs for generated or unrelated changes. Run focused tests, then all applicable spec gates. Core must have no console implementation/config, Node toolchain, or console packaging; an external docs link is allowed. The console must build cleanly and pass the spec's live checks.

Do not claim completion unless boundaries and applicable gates pass. If publishing or an immutable revision blocks final pinning, separate completed work from the blocker. Finish with cutover revisions, paths moved/removed, dependency strategy, exact test results, remaining risks, and status for both repositories. Do not commit or push unless explicitly requested.
