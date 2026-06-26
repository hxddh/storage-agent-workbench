# Architecture

## Overview

Storage Agent Workbench is a local-first desktop app.

Architecture:

```text
Tauri desktop shell
  ↓
React / Vite / TypeScript frontend
  ↓
Python FastAPI sidecar
  ↓
Agent runtime and whitelist tool layer
  ↓
SQLite / DuckDB / keyring / local files
```

## Tauri

Tauri is responsible for:

- Desktop shell
- Launching the sidecar in later phases
- Packaging
- Local desktop integration

Tauri is not responsible for:

- Agent logic
- S3 logic
- Analysis logic
- Secret processing

## Frontend

The frontend is responsible for:

- Claude/Codex-like three-column UI
- Runs
- Providers
- Datasets
- Reports
- Settings
- Tool Timeline
- Metrics cards
- Findings
- Report preview

## Sidecar

The Python FastAPI sidecar is responsible for:

- Local API
- Health check
- SSE streaming in later phases
- SQLite metadata
- keyring access in later phases
- S3 tools in later phases
- DuckDB analysis in later phases
- Report generation in later phases
- Agent runtime integration in later phases

## Storage responsibilities

SQLite stores application metadata:

- Providers
- Runs
- Messages
- Tool calls
- Audit logs
- Approval events
- Dataset metadata
- Report metadata

DuckDB stores analytical data:

- Access logs
- Inventory files
- Sampled object metadata
- Derived metrics

keyring stores secrets:

- Model API keys
- Cloud access keys
- Secret keys
- Session tokens

Local files store:

- Raw uploaded files
- Run artifacts
- Markdown reports
- DuckDB files

## Local API

Default sidecar URL:

```text
http://127.0.0.1:8765
```

Phase 01 only implements:

```text
GET /health
```

## Future streaming

Use Server-Sent Events for run events:

```text
GET /runs/{run_id}/events
```

Do not introduce WebSocket unless explicitly requested.

## Agent planner modes

Runs carry a `planner_mode` (`deterministic` by default, or `agent`). Two
distinct agent paths exist:

- **Tool-calling planner** (Phase 07) — for `diagnostic` and
  `bucket_config_review`. A controlled LLM loop selects from the read-only
  whitelist tools through the shared tool runner; outputs are sanitized/bounded
  before reaching the model. Implemented in `agent_runtime/agent_service.py`
  (seam: `AGENT_LOOP`).
- **Interpretation-only narrator** (Phase 13) — for `access_log_analysis` and
  `inventory_analysis`. The deterministic DuckDB analysis runs first and
  produces metrics + findings; the executor then hands the model **only** a
  bounded, sanitized aggregate context (run/dataset metadata + metrics +
  findings) and asks for a structured narrative. The model has **no tools**, so
  it cannot reach raw logs/rows, SQL, object listings, or any S3 API.
  Implemented in `agent_runtime/analysis_agent.py` (seam: `ANALYSIS_LOOP`); the
  analysis executors (`runs/access_log_run.py`, `runs/inventory_run.py`) branch
  on `planner_mode`. `run_service` routes these run types to their executor (not
  to the tool-calling planner) regardless of mode.

Both seams are mockable so tests run without the OpenAI Agents SDK or an API
key. A missing model provider key fails the agent run cleanly and never affects
deterministic runs. The generated report keeps deterministic metrics and the
agent interpretation in separate, clearly-labelled sections.

## Packaging & desktop integration (Phase 08)

- The Python sidecar is bundled with PyInstaller (`sidecar/packaging/`) into a
  one-dir executable, `storage-agent-sidecar`.
- The Tauri v2 shell launches the bundled sidecar as a child process on a free
  localhost port, passes `STORAGE_AGENT_DATA_DIR` (the OS app-data dir), exposes
  the URL via the `get_sidecar_url` command, and terminates it on app exit.
- Dev mode runs the sidecar separately; the frontend resolves the URL from
  `VITE_SIDECAR_URL` (dev) or the Tauri command (prod), with a localhost
  fallback. The only spawned process is the internal sidecar — there is no
  user-facing shell/subprocess tool.
- See `docs/packaging.md`. Rust toolchain is required for the desktop build.
