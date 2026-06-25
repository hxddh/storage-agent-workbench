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

Not implemented yet:

- Provider storage
- keyring
- S3 tools
- DuckDB analysis
- Agent runtime
- Report generation
- Packaging

## Local development

### Sidecar

```bash
cd sidecar
python -m venv .venv
source .venv/bin/activate
pip install -e .
uvicorn app.main:app --reload --host 127.0.0.1 --port 8765
```

Health check:

```bash
curl http://127.0.0.1:8765/health
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
