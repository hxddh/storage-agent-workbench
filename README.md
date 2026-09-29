# Storage Agent

**Current release: v8.1.0**

Storage Agent is a local-first desktop Agent for object storage — AWS S3 and every S3-compatible service. Give it a goal or a problem; it investigates with real, read-only, bounded tools, stays steerable and stoppable while it works, and answers with evidence. What it learns about your storage — accounts, buckets, their posture and the Issues found there — outlives the task that learned it.

> **The estate is the object; Agent Tasks are how work is done. One item stream is the truth.**

It is not a chatbot wrapped around a storage console, and it never writes to your storage: fixes are text you apply with your own credentials.

## How it works

- **One conversation.** A task reads top to bottom, oldest first: your request, one line for what the Agent did (expand it for each step), the answer with its findings and figures. Follow up as often as you like — nothing is reordered, dropped or repeated, across reloads too. Suggested next steps fill the Composer.
- **Send, add to the request, stop.** One Composer: send a request at rest; add to it while the Agent works; stop it and keep what it found. A request sent while the Agent works is queued.
- **Edit a request.** The Agent answers the new version on its own branch; switch between versions. **Details** holds the report, usage and every tool call.
- **Your storage.** Surveys and reviews are remembered per account. The home lists what needs attention, most severe first; a row opens the bucket — its Issues, configuration, notes and history. An opt-in watch re-checks an account on a schedule and opens one task when something new turns up.
- **Fix packs.** Each Issue's fix comes as an AWS CLI command, a Terraform resource or the API document, with a preview of what applying it would change drawn from evidence (anonymous requests in the bucket's access logs, existing lifecycle rules) — or a plain *cannot tell*. Verify re-checks it read-only and closes the Issue; if the problem comes back, it reopens.
- **Quick Ask.** ⌘⇧Space opens a small window for one question; the tray says what needs attention.
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
