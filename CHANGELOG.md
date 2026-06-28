# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow semantic versioning once it reaches 1.0.

## [Unreleased]

## [0.19.2] - 2026-06-28

Correct version display + documented signing path. Ad-hoc signed (not
notarized), macOS arm64.

### Fixed

- **The app reported version 0.1.0** (e.g. in the About box). The macOS bundle
  version comes from `tauri.conf.json`, not the release tag, and it was never
  updated. Bumped it, and the release workflow now stamps the bundle version
  from the release tag at build time, so the version is always correct.

### Added

- **`docs/signing.md`** — how macOS signing/notarization works here, what a
  comparable app (omni-macos) does (Developer ID + notarytool, $99/yr Apple
  Developer Program), the extra hardened-runtime entitlements our Python sidecar
  needs, and the exact steps + CI secrets to turn on notarized, prompt-free
  releases. Added `scripts/macos-entitlements.plist` scaffolding for that path.
- Clearer first-launch instructions in the release notes (the one-time
  `xattr -dr com.apple.quarantine` / right-click → Open step).

### Notes

- Frictionless (no Gatekeeper prompt) distribution still requires Apple
  notarization, which needs a paid Apple Developer ID — there is no free
  workaround. The pipeline is ready to notarize once those credentials are added
  as CI secrets; until then, builds remain ad-hoc signed with the documented
  one-time open step.

## [0.19.1] - 2026-06-28

Fixes a truncation bug in agent answers. Ad-hoc signed (not notarized), macOS arm64.

### Fixed

- **Long enumerations were silently cut to ~8 rows.** Asking the agent to list
  all buckets (or any long list) returned only the first ~500 characters — a
  96-row table came back as 8 rows, and the agent would even claim the result
  was "truncated by a length limit" or propose re-running the tool. Root cause:
  the chain-of-thought stripper applied to every answer ended with a hard
  `text[:500]` cap, so it — not the documented answer limit — was the binding
  constraint. The stripper now only removes reasoning markers and leaves length
  to the real caps; answer caps were also raised (12000 → 48000 chars) and an
  explicit generous model `max_tokens` is set. The instructions now explicitly
  require complete enumeration. Verified live: "list all my buckets" now returns
  all 96 rows. Regression tests added.

## [0.19.0] - 2026-06-28

First formal (non-prerelease) release of the 0.19.0 line. Adds full multi-language
support and a light theme. Ad-hoc signed (not notarized — Gatekeeper still
requires a right-click → Open on first launch), macOS arm64.

### Added

- **Multi-language UI (English + 简体中文).** A dependency-free i18n layer with a
  language switcher in Settings → Appearance. Language is auto-detected from the
  OS on first run and remembered per device. The whole product surface is
  localized — session rail, the thread (greeting, composer, suggestions, slash
  commands, tool/run/triage/proposal cards, errors), command palette, first-run
  wizard, and the full model/cloud provider settings — and the suggestion prompts
  themselves localize so a Chinese user sends Chinese.
- **Light theme.** A second theme alongside dark, switchable in Settings →
  Appearance and remembered per device (applied before first paint, no flash).
  All surfaces, the accent, and the neutral text ramp are driven by CSS variables
  so both themes stay consistent across every screen.

### Notes

- This is a formal release, but signing is unchanged from the pre-releases:
  **ad-hoc signed, not Apple-notarized.** First launch: right-click the app →
  Open (or allow it in System Settings → Privacy & Security), then it opens
  normally. The bundled sidecar is validated on first extraction, so first launch
  can take up to ~1 minute.
- A few deep, rarely-used flows (the new-run form, evidence-import dialog,
  account-profile panel, run transcript) are not yet localized; the i18n layer is
  in place to extend them.

## [0.19.0-pre.9] - 2026-06-28

A Codex/Cursor-grade start view and agent-driven next steps. Ad-hoc signed
(not notarized), pre-1.0, macOS arm64.

### Changed

- **New-chat view rebuilt as a centered, composer-forward "start" screen**
  (Codex/Cursor): the composer is the centerpiece — greeting above, suggestion
  chips below — instead of a greeting at the top with the composer pinned to the
  bottom over an empty void. In an active conversation the composer drops to the
  bottom and turns scroll above it.
- **Composer refined** to match the references: a model-picker pill (with
  chevron), `⏎ send · ⇧⏎ newline` hints, and a circular send button that fills
  with the accent only when there's text.

### Fixed

- **Next-step proposals are now agent-driven, not canned.** A generic
  "Run account discovery" chip used to reappear after *every* answer when the
  agent itself proposed nothing — even after a one-line definitional reply. The
  thread now shows the agent's own proposals once it has answered, and only
  falls back to the session's default next steps before the first turn.

## [0.19.0-pre.8] - 2026-06-28

Skills become real Agent Skills. Ad-hoc signed (not notarized), pre-1.0,
macOS arm64.

### Changed

- **Skills now follow the Agent Skills paradigm (progressive disclosure).** The
  agent's context carries a compact catalog (name + description for all 16
  StorageOps skills); it loads a skill's full method on demand via a new
  read-only `read_skill` tool — instead of a keyword matcher pre-stuffing full
  skill bodies into every prompt. The model chooses; context stays lean.
- **Removed the self-contradictory "tools/scripts disabled" skill wrapper.** It
  pre-dated the tool-using agent and told it not to do what it now does.
- **Rewrote all 16 SKILL.md bodies + the registry to be app-native.** They were
  written for a different runtime (helper scripts, `references/` files, foreign
  tools, a foreign output contract). Each now keeps its decision tree but maps
  its workflow to the agent's real read-only tools (`test_credentials`,
  `head_object`, `test_addressing_style`, `inspect_endpoint_tls`,
  `review_bucket_*`, …) and confirmed runs, and reports facts-vs-inference like
  the rest of the app.

### Fixed

- Frontmatter trimmed to `name` + `description`; dropped `recommended_tools`,
  `estimated_tokens`, and other foreign-runtime metadata. A guard test now fails
  the build if foreign-runtime artifacts reappear in the pack.

## [0.19.0-pre.7] - 2026-06-27

A more capable agent and a markdown-grade thread. Ad-hoc signed (not
notarized), pre-1.0, macOS arm64.

### Changed

- **The chat agent gets the full read-only diagnostic toolset.** It called
  itself a diagnostician but could only list/head/review; it can now also run
  `test_credentials` (auth/403 root cause), `head_object` (per-key
  metadata/404), `test_range_get` (range support/latency), `test_addressing_style`
  (virtual-hosted vs path-style — SignatureDoesNotMatch / endpoint), and
  `inspect_endpoint_tls` (TLS handshake/expiry), plus the
  `review_bucket_performance_profile` review that was missing from chat. It
  chains probes across up to 16 turns (was 8). Every tool stays read-only,
  scoped, bounded, audited, and secret-safe.
- **Markdown answers rendered to Codex/Cursor grade.** Horizontal rules now
  render as dividers (were literal `---`), plus blockquotes, links, italics,
  refined tables (uppercase headers, zebra rows) and heading rhythm. Tool-trace
  rows stay on one line with truncation so long bucket names don't wrap.

### Fixed

- Sending the first message in a new chat no longer flashes the empty state —
  the optimistic user turn + thinking/streaming bubble is preserved when the
  session is created mid-send. Next-step proposals are hidden while a turn is in
  flight.

## [0.19.0-pre.6] - 2026-06-27

Streaming agent answers. Ad-hoc signed (not notarized), pre-1.0, macOS arm64.

### Added

- **Streaming chat (SSE).** The agent's turn now streams live: read-only tool
  traces appear as they run and the answer types in token-by-token, with a
  caret while it writes (Codex/Cursor-style). New endpoint
  `POST /sessions/{id}/messages/stream`.
- **Automatic, lossless fallback.** Some OpenAI-compatible providers (notably
  DeepSeek) mishandle streaming when a turn makes tool calls and abort mid-stream;
  on any stream error the client transparently falls back to the blocking turn,
  so the answer is always correct. The stream endpoint persists nothing until it
  completes, so the fallback never duplicates the turn. Explanatory (no-tool)
  answers stream end-to-end on all providers.

### Fixed

- Parallel tool calls are disabled for streaming runs, which avoids a class of
  malformed follow-up messages with chat-completions providers.

## [0.19.0-pre.5] - 2026-06-27

The in-chat agent becomes a real agent. Ad-hoc signed (not notarized),
pre-1.0, macOS arm64.

### Changed

- **The chat agent now investigates live.** It was interpretation-only (no
  tools); it now uses read-only tools — `list_providers`, `list_buckets`,
  `head_bucket`, bounded `list_objects`, `get_bucket_config_summary`, and
  `review_bucket_*` — choosing the provider/bucket itself and answering from
  real results (e.g. "列出我的 bucket" lists them directly). All guardrails
  remain: no destructive/mutating operations exist, scans are bounded, every
  call is audited, credentials stay in the OS keychain and never reach the
  model, and anything that moves data or runs a large/analysis job stays a
  confirmed run.
- **Inline tool-call transparency** (Codex/Cursor-style): each answer shows the
  read-only tools it ran, e.g. `list_buckets · Baidu BOS → 96 buckets`,
  persisted with the message.
- One-pick cloud setup, ⌘K palette, slash commands, live "thinking" state, and
  richer markdown (carried from pre.4 line).

### Fixed

- Next-step proposals are actionable: `prepare` falls back to the configured
  provider (auto-binds the only one) and run proposals always open the run form.
- Stray green focus ring recolored to the indigo accent; composer double-ring
  removed; model chip refetches when the sidecar connects.
- Provider auth/404 failures no longer show "Add a model API key"; they show an
  actionable message with an Open settings action.

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

[Unreleased]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.2...HEAD
[0.19.2]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.2
[0.19.1]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.1
[0.19.0]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0
[0.19.0-pre.9]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.9
[0.19.0-pre.8]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.8
[0.19.0-pre.7]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.7
[0.19.0-pre.6]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.6
[0.19.0-pre.5]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.5
[0.19.0-pre.4]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.4
[0.19.0-pre.3]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.3
[0.19.0-pre.2]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.2
[0.19.0-pre.1]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.1
