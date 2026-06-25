# Storage Agent Workbench

A local-first, Claude/Codex-like desktop workbench for object storage and S3-compatible diagnostics and analysis.

## Goal

Storage Agent Workbench helps storage engineers, SREs, data infrastructure engineers, and developers analyze object storage systems.

MVP target:

- Diagnostic runs
- Access log analysis
- Inventory and capacity analysis
- Bucket configuration review
- Markdown reports

This is not a generic chat assistant. It is a task-oriented workbench built around Analysis Runs.

## Fixed stack

- Desktop: Tauri v2
- Frontend: React + Vite + TypeScript
- UI: Tailwind CSS
- Backend sidecar: Python + FastAPI + Uvicorn
- Agent runtime: OpenAI Agents SDK Python
- S3 SDK: boto3 / botocore
- Analysis engine: DuckDB + PyArrow + pandas
- App metadata: SQLite
- Secrets: Python keyring / system Keychain
- Streaming: Server-Sent Events

## Phase 01 status

Implemented in Phase 01:

- Project skeleton
- Documentation
- Tauri / React / Vite shell
- Python FastAPI sidecar
- `GET /health`
- Sidecar status in UI
- Basic CI
- Example files

## Phase 02 status

Implemented in Phase 02 (`phase/02-providers`):

- Local data layer: SQLite initialization + migration runner
- All app-metadata tables (`model_providers`, `cloud_providers`, `runs`,
  `messages`, `tool_calls`, `approval_events`, `audit_logs`, `datasets`,
  `reports`)
- Python `keyring` wrapper (`save_secret` / `get_secret` / `delete_secret`)
- Secret-redaction utility (with tests)
- Model provider CRUD + test endpoint
- Cloud provider CRUD
- Frontend Model Providers / Cloud Providers pages

Secrets are stored only in the system Keychain via `keyring`. SQLite stores
only `keyring://...` references. API responses and logs never echo plaintext
secrets.

Not implemented yet:

- S3 tools
- DuckDB analysis
- Agent runtime
- Report generation
- Packaging

## Requirements

- **Python 3.12** (recommended; pinned in `.python-version`)
- Node.js 20+
- Rust toolchain (for the Tauri desktop shell only)

## Local development

### Sidecar

Use Python 3.12 (see `.python-version`).

```bash
cd sidecar
python3.12 -m venv .venv   # or: python -m venv .venv
source .venv/bin/activate
pip install -e .
uvicorn app.main:app --reload --host 127.0.0.1 --port 8765
```

Health check:

```bash
curl http://127.0.0.1:8765/health
```

By default the SQLite database is created at `data/app.db` (relative to the
repo root). Override with the `SAW_DB_PATH` environment variable.

### Sidecar tests

```bash
cd sidecar
pip install -e ".[dev]"
pytest -q
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Tauri

```bash
cd src-tauri
cargo tauri dev
```

## Security

See:

- `CLAUDE.md`
- `docs/security.md`

Core rules:

- No plaintext secrets in SQLite, logs, traces, reports, or prompts.
- No generic shell tool.
- Whitelist tools only.
- Readonly by default.
- No destructive S3 operations in MVP.
