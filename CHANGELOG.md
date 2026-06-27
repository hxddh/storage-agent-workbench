# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow semantic versioning once it reaches 1.0.

## [Unreleased]

## [0.19.0-pre.4] - 2026-06-27

Restores agent mode in the packaged app and adds Codex/Cursor-style
interactions. Ad-hoc signed (not notarized), pre-1.0, macOS arm64.

### Fixed

- **Agent mode was broken in the packaged app** ("OpenAI Agents SDK is not
  available in this environment"). The PyInstaller spec listed `agents` /
  `openai` as bare hidden imports, which isn't enough — they import submodules
  at import time, so the one-file bundle failed to load them (dev worked because
  the venv had everything). The spec now collects `agents`, `openai`, and
  `griffe` in full. Verified on a freshly built bundle.
- Provider auth/404 failures no longer show "Add a model API key" (which implied
  none was configured). The needs-key prompt fires only on the real "no model
  provider configured" case; other failures show an actionable message with an
  Open settings action.

### Added

- **⌘K command palette** — quick-switch chats, New chat, Settings; type-to-filter
  with arrow/enter/esc. Global shortcuts ⌘K, ⌘N (new chat), Esc (close overlays).
- **Composer slash commands** — `/` opens a menu: `/diagnose`, `/logs`,
  `/inventory`, `/config`, `/account`, `/optimize` seed a prompt; `/report`
  generates the chat report.
- **Live "agent is working" state** — the user turn appears instantly and an
  animated indicator with rotating status replaces the send spinner until the
  reply lands.
- **Richer markdown** in agent replies — fenced code blocks with a language label
  and Copy button, headings, tables, lists; plus a hover Copy on agent messages.

## [0.19.0-pre.3] - 2026-06-27

UI/UX pass toward Codex/Cursor conventions, plus simpler cloud setup.
Ad-hoc signed (not notarized), pre-1.0, macOS arm64 primary target.

### Changed

- Dropped "investigation" terminology — it's "New chat" / "Recent" / chat now.
- Rail: flat brand mark, quiet New-chat row, recent list with a left accent bar
  on the active chat + relative time, compact status + settings footer.
- Thread: slim header with the chat title and a model badge (shows the configured
  provider model); a fresh chat shows just the canvas and composer.
- Messages: user turns are a subtle right-aligned bubble; agent turns are clean
  labeled prose (markdown). Runs are collapsible tool-call blocks, triage is a
  tool-style block, and next-step proposals are light action chips.
- Composer (Cursor-style): a rounded panel with a model chip and send row.
- **One-pick cloud-provider setup.** Choosing a provider (AWS S3, Alibaba OSS,
  Tencent COS, Baidu BOS, Volcengine TOS, Cloudflare R2, Backblaze B2, Google
  Cloud Storage, or Custom) fills in endpoint / addressing / signature; you enter
  region (or the R2 account id) plus access key + secret key. Endpoint override,
  addressing, signature, session token, mode, and bucket/prefix allowlists move to
  a collapsed Advanced section. Provider-panel copy is now English throughout.

### Notes

- After configuring read-only S3 credentials, the agent can enumerate the
  account's buckets and snapshot each bucket's configuration (account discovery),
  then review security / lifecycle / cost / performance per bucket — listing all
  buckets requires the `s3:ListAllMyBuckets` permission.

## [0.19.0-pre.2] - 2026-06-27

Second pre-release; supersedes the withdrawn v0.19.0-pre.1. Ad-hoc signed
(not notarized), pre-1.0, macOS arm64 primary target.

### Changed

- **Rebuilt the desktop UI into a thread-first agentic workbench (Codex/Cursor
  style).** A single conversation thread with a slim session rail and **one
  unified composer** — the agent routes intent; offline error triage is an
  automatic fallback, not a separate mode. Tool runs, triage cases, and
  next-action proposals render as inline cards; nothing runs without
  confirmation.
- Reframed the product around the agent's **full capability surface** — diagnose
  errors, analyze access logs, inventory & capacity, review bucket configuration,
  map the account, and find optimizations — rather than error triage alone. A
  capability-forward empty state seeds the composer.
- First-run wizard → inline settings drawer for model- and cloud-provider setup.
- Refined the visual language to a **near-monochrome dark palette** with a single
  restrained accent, flat marks, hairline borders, and markdown agent answers.
- Retired the previous tabbed admin-panel shell (Home / Sessions / Providers /
  Runs / Datasets / Reports nav, sidebar, context panel).

### Fixed

- **macOS bundle "app is damaged" / broken code-signature seal.** The build now
  ad-hoc seals the `.app` after bundling (`scripts/sign-macos-app-bundle.sh`),
  rebuilds the DMG from the sealed app, and gates on `codesign --verify --deep
  --strict`. Sealing intentionally does **not** enable the hardened runtime —
  under it the PyInstaller Python sidecar can't load its bundled framework and
  never starts.
- **Third-party OpenAI-compatible model providers (e.g. DeepSeek) now work.** The
  agent honors the provider `base_url` with the Chat Completions API; the SDK's
  trace upload to OpenAI is disabled.
- First-message next-action proposals were dropped on a new investigation.
- Removed stale "Phase 01 / bootstrap only" copy.

### Security

- Secrets stay in the OS keychain / keyring; never in SQLite, logs, reports, or
  model prompts.
- The agent no longer uploads traces or prompts to OpenAI's tracing backend.
- Read-only S3 by default; no destructive operations; bounded, sanitized agent
  context; chain-of-thought not persisted.

### Notes

- **v0.19.0-pre.1 was withdrawn** after product smoke: the UI was not yet a
  usable agent-first workbench and the macOS seal was broken. Both are fixed here.
- **First macOS launch is slow (up to ~1 min):** macOS validates the freshly
  ad-hoc-signed one-file sidecar on first extraction; later launches are fast. The
  window shows "Sidecar: Connecting" until ready.
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

[Unreleased]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.0-pre.4...HEAD
[0.19.0-pre.4]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.4
[0.19.0-pre.3]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.3
[0.19.0-pre.2]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.2
[0.19.0-pre.1]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.1
