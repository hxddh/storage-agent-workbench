# Storage Agent

**Current release: v0.93.0**

Storage Agent is a local-first desktop Agent for object storage and S3-compatible systems. Give it a storage goal or problem; it investigates with real read-only tools, remains steerable while it works, stops at explicit confirmation boundaries, and produces durable results backed by reviewable execution and evidence.

The product is organized around one invariant:

> **The Agent Task is the application.**

Canonical work model:

> **Direction → Execution → Decision (when required) → Work Result → Artifact**

Storage Agent is not a chatbot wrapped around a storage console, and it is not a page-per-backend-table admin application.

## How the product works

### Agent Task

A durable Task is the primary unit of work. Task navigation shows active/recent work and projects both durable state and real in-flight runtime state.

### Delegate, Steer, Stop

There is one Agent input.

- At rest: **Delegate** a goal, problem, constraint, or follow-up.
- While the Task is executing: use the same control to **Steer** the running work.
- Use **Stop** to cancel the active turn.

Switching to another Task does not destroy the first Task's real in-flight state. Reopening it reconnects to the same durable/live work.

### Direction

User input is durable task direction: the objective, correction, constraint, or steering instruction. It is not modeled as a generic chat bubble.

### Execution

Execution is real runtime/tool activity. Storage Agent shows actual progress and sanitized tool detail; it does not invent plans, workers, terminals, browsers, worktrees, or sub-agents that the runtime does not implement.

### Decision required

Read-only investigation can proceed autonomously. Operations that move cloud data or cross a configured safety boundary pause at an explicit **Decision required** state before execution.

### Work Result and Review

Completed work becomes a durable **Work Result**. Evidence, Execution detail, and Markdown Reports are contextual artifacts that can be reviewed beside the same Task rather than becoming separate top-level applications.

## Storage capabilities

Storage Agent can currently:

- diagnose S3-compatible credentials, reachability, endpoint/region/addressing/TLS behavior;
- inspect buckets and bounded object metadata with read-only tools;
- discover accounts and visible buckets;
- review bucket security, lifecycle, observability, cost, and performance configuration;
- inspect versions, multipart state, object lock, ACLs, tags, attributes, conditional/range behavior, and bounded content previews where safe;
- analyze uploaded access logs and inventory locally with DuckDB;
- plan and confirm bounded cloud Evidence Import;
- triage supported storage errors deterministically, including without a configured model provider;
- preserve task memory, findings, execution history, evidence references, and turn metrics;
- generate durable Markdown Report artifacts.

## Safety model

Storage Agent deliberately has a narrower action surface than a general-purpose computer-use Agent.

- **Local-first:** application metadata, imported data, and artifacts live in the OS application-data directory.
- **Encrypted local secret vault:** cloud/model credentials are stored only through the encrypted vault; SQLite stores opaque references.
- **Secrets never enter model context:** credentials, Authorization material, signatures, tokens, and sensitive query parameters are excluded/redacted.
- **Read-only storage capabilities:** no destructive/mutating S3 tool is shipped.
- **No generic shell/arbitrary subprocess:** Agent capabilities are typed and whitelisted.
- **Bounded analysis:** object listings, previews, scans, evidence imports, and model context are explicitly bounded.
- **Confirmation for data movement:** managed cloud Evidence Import and other gated operations require an explicit user decision.
- **Evidence truth:** persisted tool/evidence records are sanitized; missing evidence remains a gap rather than being guessed.
- **No chain-of-thought persistence/exposure.**

See [docs/security.md](docs/security.md) for the authoritative security contract.

## Architecture

```text
Tauri v2 desktop shell
        │
React + TypeScript Agent UI
        │ localhost HTTP / SSE
Python FastAPI Sidecar
        │
        ├── user-configured model endpoint
        └── user-configured S3-compatible storage
```

The Sidecar owns persistence, Agent runtime, tools, evidence, reports, provider adapters, and the encrypted-vault integration. The UI never receives secret values.

Some backend names predate the current product model and remain compatibility contracts:

| Product concept | Current compatibility storage/API |
| --- | --- |
| Agent Task | `sessions` + `/sessions/...`; `/agent-tasks` projects task-list state |
| Direction / Work Result | `session_messages` |
| Execution | `runs`, `session_runs`, `tool_calls`, turn metrics |
| Evidence / Artifact | evidence/import/report persistence |

Those names do not define the frontend information architecture.

## Install

Download platform assets from [GitHub Releases](https://github.com/hxddh/storage-agent-workbench/releases). v0.93.0 ships:

| Platform | Asset pattern |
| --- | --- |
| macOS Apple Silicon | `storage-agent-vX.Y.Z-macos-arm64.dmg` / `.app.zip` |
| Linux x64 | `storage-agent-vX.Y.Z-linux-x64.deb` |
| Windows x64 | `storage-agent-vX.Y.Z-windows-x64-setup.exe` |

Each platform has a `SHA256SUMS-*` manifest. Current builds are not distributed with Apple notarization or Windows Authenticode signing, so the OS may warn on first launch. See [docs/install.md](docs/install.md) and [docs/signing.md](docs/signing.md).

## Quality gates

The repository protects the v0.93 architecture with executable tests and real-state validation:

- TypeScript typecheck/lint and Vitest unit tests.
- Agent ownership and legacy-architecture regression tests.
- Documentation-contract tests so normative docs cannot silently drift back to retired product semantics.
- Python Sidecar tests and packaged-Sidecar smoke.
- Real-Sidecar Playwright E2E for delegation, execution, steering, stopping, decisions, task switching/concurrency, Evidence/Report Review, persistence, localization, accessibility, contrast, and secret sanitization.
- Real-state visual-review captures.
- macOS Apple Silicon, Linux x64, and Windows x64 desktop build/runtime verification.

## Documentation

Start at [docs/README.md](docs/README.md). It defines documentation precedence and distinguishes current specifications from historical release/rebuild records.

Key current documents:

- [docs/product.md](docs/product.md) — canonical product model.
- [docs/architecture.md](docs/architecture.md) — frontend/runtime ownership and compatibility boundaries.
- [docs/security.md](docs/security.md) — safety and secret handling.
- [docs/api.md](docs/api.md) — Sidecar API contracts.
- [docs/data-model.md](docs/data-model.md) — current persistence model and migrations.
- [docs/tools.md](docs/tools.md) — Agent capability contract.
- [docs/roadmap.md](docs/roadmap.md) — post-0.93 direction.
- [docs/release.md](docs/release.md) — release flow.

Release notes and [CHANGELOG.md](CHANGELOG.md) are historical records. They may contain terminology that was correct for older versions and must not be used to reconstruct the current architecture.

## Development

See [CLAUDE.md](CLAUDE.md) for the implementation contract used by coding Agents and contributors. Architecture/product changes must update the relevant canonical docs and executable contracts in the same PR.

## License

[Apache License 2.0](LICENSE).
