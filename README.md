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

## Phase 03 status

Implemented in Phase 03 (`phase/03-s3-tools`):

- Whitelisted, **read-only** S3-compatible tool layer (boto3/botocore):
  `test_credentials`, `head_bucket`, `list_objects_v2`, `head_object`,
  `test_range_get`, `test_path_style_vs_virtual_host`, `inspect_tls`
- Cloud Provider **Test Connection** runs a real read-only credential check
- Every tool call is recorded in `tool_calls` + `audit_logs`, sanitized
- Frontend Tool Result Card + per-provider Test Connection panel

Read-only guarantees: no PutObject/DeleteObject/DeleteObjects/DeleteBucket/
PutBucketPolicy/PutBucketAcl/PutLifecycle, no generic shell, no subprocess.
`list_objects_v2` requires `max_keys` (hard-capped at 1000, ≤20 sample keys);
`test_range_get` requires a bounded Range (≤4 MiB) and never downloads full
objects; `inspect_tls` uses Python `ssl`/`socket` (no `openssl` shell-out).

Tool endpoints (all `POST`): `/cloud-providers/{id}/test`,
`/tools/test-credentials`, `/tools/head-bucket`, `/tools/list-objects-v2`,
`/tools/head-object`, `/tools/test-range-get`,
`/tools/test-path-style-vs-virtual-host`, `/tools/inspect-tls`.

## Phase 04 status

Implemented in Phase 04 (`phase/04-runs-timeline`):

- **Analysis Runs** with a deterministic (rule-based) planner — no LLM, no
  OpenAI Agents SDK. Only `diagnostic` runs execute; the other run types are
  created as `not_implemented` placeholders.
- A diagnostic run drives the Phase 03 read-only tools (`test_credentials`,
  `head_bucket`, `list_objects_v2` with bounded `max_keys`) through the shared
  tool runner, attaching every `tool_calls` / `audit_logs` row to the `run_id`.
- **Server-Sent Events** stream `agent_plan`, `tool_call_started/finished`,
  `agent_message`, `finding`, `report_ready`, and `error` (in-memory bus; no
  Redis/Celery/queue — best-effort, local-only).
- A local Markdown report is written to `data/runs/{run_id}/report.md` and
  referenced from the `reports` table.
- Frontend: Runs list, New Run form, Run Detail (plan + Tool Timeline + findings
  + report preview + status), and a Reports view.

Run/report endpoints: `GET/POST /runs`, `GET /runs/{id}`,
`POST /runs/{id}/message`, `GET /runs/{id}/events` (SSE), `GET /reports/{id}`.

Reports never contain secrets; SSE events and tool outputs are sanitized;
`list_objects_v2` is bounded (not a full scan) and no object bodies are
downloaded.

## Phase 05 status

Implemented in Phase 05 (`phase/05-duckdb-analysis`):

- **DuckDB / PyArrow / pandas** local analysis engine. Each run gets its own
  `data/runs/{run_id}/analysis.duckdb`; SQLite still holds only app metadata.
- `access_log_analysis` runs: `detect_log_format` → `import_access_logs`
  (JSONL / text / CSV → DuckDB `access_logs`) → `analyze_access_logs`
  (status/method distributions, requests-by-hour, top keys/prefixes/UAs, 4xx/5xx
  rates) + findings + Markdown report.
- `inventory_analysis` runs: `import_inventory_file` (CSV / Parquet → DuckDB
  `inventory_objects`) → `analyze_inventory` (size histogram, age distribution,
  prefix/storage-class distributions, small-object ratio, top large objects) +
  findings + Markdown report.
- Dataset upload (`POST /runs/{id}/datasets/upload`, multipart) into
  `data/runs/{id}/raw/`; `GET /datasets`, `GET /datasets/{id}`.
- Every analysis action (`detect_log_format`, `import_*`, `analyze_*`,
  `generate_markdown_report`) is recorded in `tool_calls` + `audit_logs` with
  `run_id`; inputs/outputs are sanitized and paths recorded relative.
- Client IPs are masked (`192.0.2.10` → `192.0.2.x`); credential-shaped values
  are redacted before they reach DuckDB, reports, or events.
- Frontend: New Run form supports run-type selection + file upload, Run Detail
  shows metrics cards, and a Datasets page lists imported datasets.

`diagnostic` (Phase 04) is retained; `bucket_config_review` and
`optimization_report` remain `not_implemented` placeholders.

Not implemented yet:

- Agent runtime (LLM / OpenAI Agents SDK)
- Bucket config review
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
