# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow semantic versioning once it reaches 1.0.

## [Unreleased]

### Changed

- Reworked the desktop UI into an **agent-first workbench**: a Home / investigation
  workspace is now the entry point (task composer + setup status + quick actions),
  with Runs / Datasets / Reports as supporting views rather than the starting point.
- Model-provider and cloud-provider setup are surfaced from Home and reflected in a
  live Context panel (setup + safety state).

### Fixed

- Removed stale "Phase 01 / bootstrap only" and "credentials arrive in later phases"
  copy from the Settings and Context panels.

### Notes

- **v0.19.0-pre.1 was withdrawn** (reverted to draft) after product smoke testing:
  the app launched and the sidecar connected, but the UI was not yet a usable
  agent-first workbench. A separate diagnosis also found the macOS bundle's ad-hoc
  code signature was broken (Gatekeeper "is damaged"); track that packaging fix
  separately.
- A planned `v0.19.0-pre.2` will carry these fixes once verified.

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
