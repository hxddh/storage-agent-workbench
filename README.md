# Storage Agent

**Release in this checkout: v14.0.0**

Storage Agent is a local-first desktop Agent for object storage — AWS S3 and every S3-compatible service. Give it a goal or a problem; it investigates with real, read-only, bounded tools, shows the work while it runs, stays steerable and stoppable, and answers with evidence. What it learns about your storage — accounts, buckets, their posture and the Issues found there — outlives the task that learned it.

> **The estate is the object; Agent Tasks are how work is done. One item stream is the truth.**

It is not a chatbot wrapped around a storage console, and it never writes to your storage: fixes are text you apply with your own credentials.

## How it works

- **One workspace, answer first.** A task reads as one conversation: what you asked, the work it caused, the Agent's answer, its findings, and the deterministic data folded beneath when you want it. While work is live, every real call and its progress is visible. Nothing is reordered, repeated or turned into a card, across reloads too.
- **Send, add to the request, stop.** One Composer, centred on Home and docked on every task: send at rest; add to it while the Agent works; stop it and keep what it found. A request sent while the Agent works is queued. The bar has a paperclip, the model and Send/Stop — no mode switch. A file uploads with real progress and can be cancelled.
- **Edit a request.** The Agent answers the new version on its own branch; switch between versions. The fork keeps its attached files. **Evidence** holds the report, usage, every check and attached files; a check opens in place to its arguments and raw data, with no second page.
- **The estate is memory.** Accounts, buckets, posture, Issues and notes are what the Agent knows, not a page you browse. Ask in plain language; the Agent resolves the account or bucket, or asks when the request is ambiguous. An opt-in watch re-checks an account on a schedule and opens one task when something new turns up.
- **Fix packs.** Each Issue's fix comes as an AWS CLI command, a Terraform resource or the API document, with a preview of what applying it would change drawn from evidence (anonymous requests in the bucket's access logs, existing lifecycle rules) — or a plain *cannot tell*. The Agent can re-check it read-only; if the problem comes back, it reopens.
- **Your models.** OpenAI (Responses API, with hosted tool search and server-side compaction), Anthropic, DeepSeek, OpenRouter, or local models (Ollama, LM Studio, vLLM, llama.cpp, any OpenAI-compatible endpoint).

## What it can do

- diagnose credentials, reachability, region, addressing, TLS, latency and presigned URLs;
- inspect buckets and objects: listings, versions, multipart uploads, object lock, ACLs, tags, attributes, range/conditional reads, bounded previews;
- survey an account (≤ 500 buckets) and review bucket security, lifecycle, observability, cost and performance configuration;
- analyze attached access logs and inventories locally with DuckDB — raw rows never reach the model;
- import a discovered inventory or access-log source (≤ 500 files / 256 MiB per call, audited, stoppable);
- triage pasted S3 errors and project the storage-class mix under lifecycle rules (no dollar figures);
- write a task report in English or Chinese.

## Safety

Secrets live only in an encrypted local vault and never reach the model, the logs or the window. Storage tools are read-only; there is no shell, SQL or raw client. Bucket/prefix scope is enforced server-side. Tool output reaches the model as untrusted data. No chain-of-thought is stored. See [docs/security.md](docs/security.md).

## Architecture

```text
Tauri v2 shell ── React window · tray
        │ localhost HTTP / SSE + per-launch token
Python Sidecar ── one Agent (OpenAI Agents SDK) ── your model endpoint
        │                                       └─ your S3-compatible storage
        └── SQLite item stream · estate · encrypted vault · DuckDB datasets
```

See [docs/architecture.md](docs/architecture.md).

## Install

Download from [GitHub Releases](https://github.com/hxddh/storage-agent-workbench/releases):

| Platform | Asset |
| --- | --- |
| macOS Apple Silicon | `storage-agent-vX.Y.Z-macos-arm64.dmg` / `.app.zip` |
| Linux x64 | `storage-agent-vX.Y.Z-linux-x64.deb` |
| Windows x64 | `storage-agent-vX.Y.Z-windows-x64-setup.exe` |

Each platform has a `SHA256SUMS-*` manifest. Builds are not notarized or Authenticode-signed, so the OS may warn on first launch. Upgrading from v4 imports your providers, estate and past results on first start; the v4 database is left untouched. See [docs/install.md](docs/install.md).

## Documentation

Start at [docs/README.md](docs/README.md): [product](docs/product.md) · [architecture](docs/architecture.md) · [security](docs/security.md) · [API](docs/api.md) · [data model](docs/data-model.md) · [tools](docs/tools.md) · [evals](docs/evals.md) · [release](docs/release.md). Release notes and the [CHANGELOG](CHANGELOG.md) are history.

## Development

See [CLAUDE.md](CLAUDE.md), the implementation contract. Product or architecture changes update the canonical docs and the executable contracts in the same PR.

```sh
cd sidecar && pip install -c requirements.lock -e ".[dev]" && pytest -q
cd frontend && npm ci && npm test && npm run build && npm run test:e2e
```

## Orbs / remote machines

`.agents/setup` prepares a fresh Amp orb (or any Debian 12 machine) with Python
3.14, the editable sidecar plus dev/packaging extras, frontend dependencies,
Playwright Chromium, and the Rust/Tauri Linux toolchain. It is idempotent:
a warm run only verifies the restored snapshot. `.agents/resume` is the fast
wake check and never installs. For a desktop build, stage the sidecar before
`cargo check`:

```sh
.venv/bin/python scripts/build-sidecar-for-tauri.py
```

## License

[Apache License 2.0](LICENSE).
