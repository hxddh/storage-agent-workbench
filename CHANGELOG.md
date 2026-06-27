# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow semantic versioning once it reaches 1.0.

## [Unreleased]

### Changed

- **Rebuilt the desktop UI into a thread-first agentic workbench (Codex-style).**
  The app is now a single conversation thread with a sticky composer and a slim
  session rail — no top-level tabs. Tool runs, error-triage cases, and next-action
  proposals all render as inline cards in the thread. The composer has two modes:
  "Ask the agent" (session message) and "Triage an error" (offline, no credentials).
- Setup is a **first-run wizard** (shown once on a fresh install with no providers)
  that leads into an inline **settings drawer** embedding model- and cloud-provider
  management. Missing-model-key states surface an inline "Add a model API key" prompt
  instead of failing opaquely.
- Next-action proposals are reviewed and prepared **inline in the thread** — Review
  previews, Prepare opens the run starter / evidence import / report as an in-thread
  modal. Nothing runs without explicit confirmation.
- Retired the previous tabbed admin-panel shell (Home / Sessions / Providers / Runs /
  Datasets / Reports navigation, sidebar, and context panel). No backend, API, schema,
  or agent-runtime changes — all capabilities are reused through the new shell.

### Fixed

- Removed the multi-view admin-panel interaction model that did not match a modern
  agentic workbench; replaced wholesale by the thread-first shell above.
- Removed stale "Phase 01 / bootstrap only" and "credentials arrive in later phases"
  copy (the panels carrying it were retired).
- **macOS bundle "app is damaged" / broken code-signature seal.** `cargo tauri build`
  with no signing identity left the main binary linker-signed with no sealed
  resources, so `codesign --verify --deep --strict` failed and Finder reported the
  app as damaged. The macOS build now ad-hoc seals the `.app` after bundling
  (`scripts/sign-macos-app-bundle.sh`) and rebuilds the DMG from the sealed app, and
  `scripts/verify-macos-app-bundle.sh` gates on `codesign --verify --deep --strict`.
  Sealing intentionally does **not** enable the hardened runtime — under it the
  PyInstaller Python sidecar cannot load its bundled framework ("different Team IDs")
  and never starts. The build remains ad-hoc (not Developer ID, not notarized), so
  the normal Gatekeeper "unidentified developer" prompt still appears.

### Notes

- **v0.19.0-pre.1 was withdrawn** (reverted to draft) after product smoke testing:
  the app launched and the sidecar connected, but the UI was not yet a usable
  agent-first workbench, and the macOS bundle's code-signature seal was broken
  (Gatekeeper "is damaged"). Both are fixed above for `v0.19.0-pre.2`.
- **First macOS launch is slow (up to ~1 min):** macOS validates the freshly
  ad-hoc-signed one-file sidecar's signature on first extraction; later launches are
  fast. The window shows "Sidecar: Connecting" until ready.
- Notarization / Apple Developer ID signing remain out of scope for these
  pre-1.0 builds.

## [0.19.0-pre.1] - 2026-06-27 [WITHDRAWN]

Withdrawn after product smoke failed (see Unreleased → Notes). Unsigned, pre-1.0,
macOS arm64.

### Added

- Local-first desktop Storage Agent Workbench through Phase 19.
- Read-only S3-compatible diagnostics.
- Account discovery and bucket configuration review.
- Managed evidence import for inventory and access logs (plan → confirm → run).
- DuckDB-based inventory and access-log analysis.
- Session-centered investigation workspace.
- Safe next-action handoff (review → prepare → confirm).
- S3 / object-storage error triage assistant.
- Bundled StorageOps skills-only context injection.
- Markdown reports.

### Security

- Secrets stay in the OS keychain / keyring.
- No plaintext secrets in SQLite, logs, reports, or model prompts.
- No generic shell or arbitrary subprocess.
- No destructive S3 operations.
- No StorageOps tools/scripts imported or executed.
- No public skill API.
- Agent context is bounded and sanitized.
- Chain-of-thought is not persisted.

### Packaging

- macOS arm64 unsigned desktop build path.
- Linux x64 and Windows x64 experimental CI builds.
- Manual `workflow_dispatch` GitHub Release workflow added for pre-release
  publication (no signing, no notarization).

[Unreleased]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.0-pre.1...HEAD
[0.19.0-pre.1]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.1
