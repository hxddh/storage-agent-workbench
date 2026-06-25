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
