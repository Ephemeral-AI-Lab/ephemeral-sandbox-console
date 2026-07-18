# Desktop application

Desktop implementation remains separate from the completed web-console
extraction. Its first planned increment is documented in
[`PHASE_1_MAIN_PAGE_SPEC.md`](PHASE_1_MAIN_PAGE_SPEC.md): a Tauri 2 shell that
reuses the existing React console and trusted Rust BFF, beginning with the
**Ephemeral Sandbox Dashboard**. Browser and desktop web-visible
assets come from the repository-level `shared/public` tree described in the
spec; generated OS packaging icons remain under `desktop/src-tauri/icons`.

Do not introduce speculative desktop abstractions into shared code. Extract or
adapt shared boundaries only when the Phase 1 requirements call for them.
