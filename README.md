# Storage Agent Workbench

Local-first desktop workbench for object storage and S3-compatible operations
analysis, evidence review, and troubleshooting.

## Status

- Pre-1.0 / dogfood-ready.
- Planned first pre-release: **v0.19.0-pre.1**.
- Supported target: **macOS arm64** (unsigned).
- Experimental CI targets: Linux x64, Windows x64.
- Not yet supported: code signing, notarization, auto-update, macOS x64/universal.

## What it is

- A **local-first desktop application** — the UI runs on your machine and talks
  to a bundled local sidecar; your data and credentials stay local.
- A **session-centered agentic workbench** for object storage / S3-compatible
  diagnostics and operations analysis — work is organized as investigations
  (sessions), not one-off chats.
- **Evidence-driven**: conclusions are grounded in artifacts you collected
  (account discovery, bucket config, imported inventory/logs, analysis results).
- **Human-in-the-loop**: the agent explains, attributes, and *proposes* next
  steps; you review and confirm before anything runs.
- Uses **bounded, read-only tools** and **sanitized context** only.
- Uses bundled **StorageOps `SKILL.md`** docs as professional-method context for
  the agent (guidance only — the skill tools/scripts are never executed).

## What it is not

- Not a generic chatbot.
- Not a cloud control plane.
- Not an object browser.
- Not a monitoring dashboard.
- Not a CMDB.
- Not a ticketing / kanban / project-management system.
- Not an auto-remediation bot.
- Not a destructive-operations tool.
- Not a static FAQ or error-code dictionary.
- Not a provider-capability database.

## Core workflows

1. Configure a model provider and a cloud (S3-compatible) provider.
2. Discover the account and its bucket evidence sources.
3. Review bucket configuration (security / lifecycle / observability / cost).
4. Import managed evidence (inventory / access logs) with explicit confirmation.
5. Analyze inventory and access logs locally.
6. Triage S3 / object-storage errors.
7. Continue the investigation inside a **Session**.
8. Review **proposed next actions** before starting anything.
9. Generate Markdown reports.

## Capabilities

- Read-only S3-compatible diagnostics.
- Account discovery.
- Bucket configuration review.
- Managed evidence import (plan → confirm → run).
- Inventory analysis (DuckDB).
- Access-log analysis (DuckDB).
- Session workspace.
- Next-action handoff (review → prepare → confirm).
- Error triage assistant.
- Skills-only StorageOps context injection.
- Markdown reports.

## Safety model

- **Local-first**: app data lives in the OS app-data directory; nothing is sent
  anywhere except the cloud/model providers you configure.
- Secrets are stored only in the **OS keychain / keyring** — never plaintext
  AK/SK/session tokens/model keys in SQLite, logs, reports, or model prompts.
- **No generic shell** and **no arbitrary subprocess** tool.
- **No destructive or mutating S3 operations.**
- **No hidden auto-run** and **no auto-confirm** — next actions stay proposals
  until you review and confirm them.
- No raw logs / inventory rows / secrets are sent to the model; agent context is
  bounded and sanitized.
- Chain-of-thought is **not** persisted.
- Bundled StorageOps tools/scripts are **not** imported or executed — only the
  `SKILL.md` guidance text is used as professional-method context.

See [docs/security.md](docs/security.md) for the full model.

## Download

Public builds are published on **GitHub Releases**.

The first public pre-release is being prepared as **v0.19.0-pre.1**. Until then,
CI build artifacts are available under **GitHub Actions** for development
verification only — they are not a substitute for a published Release. See
[docs/release.md](docs/release.md) for the distinction.

## Install

See [docs/install.md](docs/install.md).

- macOS arm64 ships as an **unsigned** `.app` (with a DMG when the bundler
  produces one).
- First launch is expected to be blocked by Gatekeeper because the build is
  unsigned. Either right-click the app → **Open** → **Open**, or clear the
  quarantine attribute:

  ```bash
  xattr -dr com.apple.quarantine "/path/to/Storage Agent Workbench.app"
  open "/path/to/Storage Agent Workbench.app"
  ```

## Local development

- Python 3.12, Node.js 20+, Rust (stable).

```bash
# sidecar tests
cd sidecar && pip install -e ".[dev]" && pytest -q

# frontend build
cd frontend && npm install && npm run build

# desktop compile check
cd src-tauri && cargo check
```

For the full phase-by-phase implementation history, see
[docs/development-history.md](docs/development-history.md).

## Documentation

- [docs/install.md](docs/install.md) — installing a pre-release build.
- [docs/release.md](docs/release.md) — build flow, CI artifacts vs Releases.
- [docs/security.md](docs/security.md) — secret handling and safety rules.
- [docs/packaging.md](docs/packaging.md) — sidecar/desktop packaging.
- [docs/development-history.md](docs/development-history.md) — phase notes.
- [CHANGELOG.md](CHANGELOG.md) — release changelog.

## Current limitations

- No code signing.
- No notarization.
- No auto-update.
- macOS x64 / universal builds are not produced.
- Linux x64 and Windows x64 are experimental (CI build/smoke only).
- ORC inventory import is not supported (CSV / Parquet only).
- CloudTrail / Storage Lens / provider access-log evidence sources are not
  integrated.
- `account_discovery` is deterministic only (no agent account-level analysis).
- No auto-remediation — the workbench analyzes and proposes; it never changes
  your storage.

## License

MIT.
