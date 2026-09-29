# Storage Agent

**Current release: v5.0.0**

Storage Agent is a local-first desktop Agent for object storage — AWS S3 and every S3-compatible service. Give it a goal or a problem; it investigates with real, read-only, bounded tools, stays steerable and stoppable while it works, and answers with evidence. What it learns about your storage — accounts, buckets, their posture and the Issues found there — outlives the task that learned it.

> **The estate is the object; Agent Tasks are how work is done. One item stream is the truth.**

It is not a chatbot wrapped around a storage console, and it never writes to your storage: fixes are text you apply with your own credentials.

## How it works

- **Delegate, Steer, Stop.** One Composer: delegate a Direction at rest; steer the running work; stop it and keep what it found. A Direction sent while the Agent works is queued.
- **Result-first tasks.** A task opens on its latest Result — the conclusion the Agent recorded (the answer, findings by severity, next steps you can ask for), then the full answer, figures from deterministic analyses, and Evidence · Report · Activity in the side pane. Earlier Directions stay below as a work log.
- **Forks.** Edit any Direction and the Agent answers the new version on its own branch; switch between versions.
- **The estate.** Surveys and reviews are remembered per account. The home lists what needs care, most severe first — each Issue with a generated fix to copy, a read-only Verify, and the task that found it. An opt-in watch re-checks an account on a schedule and opens one task when something new turns up.
- **Quick Ask.** ⌘⇧Space opens a small window for one question; the tray says what needs care.
- **Your models.** OpenAI (Responses API, with hosted tool search and server-side compaction), Anthropic, DeepSeek, OpenRouter, or local models (Ollama, LM Studio, vLLM, llama.cpp, any OpenAI-compatible endpoint).

## What it can do

- diagnose credentials, reachability, region, addressing, TLS, latency and presigned URLs;
- inspect buckets and objects: listings, versions, multipart uploads, object lock, ACLs, tags, attributes, range/conditional reads, bounded previews;
- survey an account (≤ 500 buckets) and review bucket security, lifecycle, observability, cost and performance configuration;
- analyze attached access logs and inventories locally with DuckDB — raw rows never reach the model;
- import a discovered inventory or access-log source (≤ 500 files / 256 MiB per call, audited, stoppable);
- triage pasted S3 errors and simulate storage-class mix and cost under lifecycle rules;
- write a task report in English or Chinese.

## Safety

Secrets live only in an encrypted local vault and never reach the model, the logs or the window. Storage tools are read-only; there is no shell, SQL or raw client. Bucket/prefix scope is enforced server-side. Tool output reaches the model as untrusted data. No chain-of-thought is stored. See [docs/security.md](docs/security.md).

## Architecture

```text
Tauri v2 shell ── React window · Quick Ask · tray
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

## License

[Apache License 2.0](LICENSE).
