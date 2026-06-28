# Storage Agent Workbench

A local-first desktop agent for object storage operations on S3-compatible
systems — diagnostics, access-log and inventory analysis, account and bucket
configuration review, error triage, and optimization. The UI runs on your
machine and talks to a bundled local sidecar — your data and credentials never
leave your computer.

It is **evidence-driven** and **human-in-the-loop**: the agent investigates with
read-only tools, grounds its conclusions in artifacts you collected, and
*proposes* next steps that you review and confirm. It never mutates your storage
and never runs an action on its own.

## Install

Download the installer for your platform from
[GitHub Releases](https://github.com/hxddh/storage-agent-workbench/releases):

| Platform | Asset |
| --- | --- |
| macOS (Apple Silicon) | `...-macos-arm64.dmg` |
| Linux (x64) | `...-linux-x64.deb` |
| Windows (x64) | `...-windows-x64-setup.exe` |

Builds are **ad-hoc signed, not notarized**, so the OS shows an
"unidentified developer" warning on first launch. See
[docs/install.md](docs/install.md) for how to open it on each platform. Cold
start takes a few seconds while the sidecar comes up.

## What it does

1. Configure a model provider and an S3-compatible cloud provider.
2. Discover the account and its buckets.
3. Review bucket configuration — security, lifecycle, observability, cost.
4. Import evidence (inventory / access logs) with explicit confirmation.
5. Analyze inventory and access logs locally with DuckDB.
6. Triage S3 / object-storage errors.
7. Keep the investigation in a **session** (rename / pin / archive / delete /
   fork) and generate Markdown reports.

The interface is a thread-first agentic workbench (Codex/Cursor-style): a session
rail, a conversation thread where runs and findings render as inline cards, and a
settings drawer. Dark and light themes; English and 中文.

## What it is not

A generic chatbot, a cloud control plane, an object browser, a monitoring
dashboard, or an auto-remediation bot. It analyzes and proposes — it does not
change your storage.

## Safety model

- **Local-first.** App data lives in the OS app-data directory; nothing is sent
  anywhere except the cloud/model providers you configure.
- **Secrets only in the OS keychain.** Access keys, secret keys, session tokens,
  and model API keys are never stored in SQLite, logs, reports, or model prompts.
- **Read-only by default.** No destructive or mutating S3 operations; no generic
  shell or arbitrary subprocess tool.
- **No hidden auto-run.** Proposed next actions stay proposals until you confirm.
- Agent context is bounded and sanitized; chain-of-thought is never persisted.
- Bundled StorageOps `SKILL.md` docs are used as professional-method *guidance*
  only — their tools/scripts are never imported or executed.

See [docs/security.md](docs/security.md) for the full model.

## Local development

Requires Python 3.12, Node.js 20+, and Rust (stable) for the desktop build.

```bash
# sidecar tests
cd sidecar && pip install -e ".[dev]" && pytest -q

# frontend build
cd frontend && npm install && npm run build

# desktop app (macOS; Linux/Windows have sibling scripts)
scripts/build-desktop-macos.sh
```

## Documentation

- [docs/install.md](docs/install.md) — installing per platform.
- [docs/product.md](docs/product.md) — product shape and core jobs.
- [docs/architecture.md](docs/architecture.md) — how the pieces fit together.
- [docs/security.md](docs/security.md) — secret handling and safety rules.
- [docs/packaging.md](docs/packaging.md) — sidecar/desktop packaging.
- [docs/release.md](docs/release.md) — release flow and platform support.
- [docs/signing.md](docs/signing.md) — macOS signing and notarization status.
- [docs/roadmap.md](docs/roadmap.md) — current status and direction.
- [CHANGELOG.md](CHANGELOG.md) — release changelog.

## License

[Business Source License 1.1](LICENSE) (BUSL-1.1). The source is public, and you
may freely read, modify, and use it for **non-production** purposes — evaluation,
development, testing, research, and personal non-commercial use. **Production or
commercial use** (including offering it to third parties as a product or hosted
service) requires a commercial license from the Licensor.

Each released version converts to the **Apache License 2.0** on its Change Date
(four years after that version's first publication). For commercial licensing,
open an issue on the repository.
