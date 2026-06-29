# Storage Agent Sidecar

Local-only FastAPI sidecar for Storage Agent Workbench.

It exposes the full local API: model/cloud provider CRUD (secrets in the
encrypted vault), read-only S3 diagnostic tools, runs (deterministic + agent
planner), DuckDB inventory/access-log analysis, account discovery, managed
evidence import, sessions, error triage, reports, and the conversational session
agent (SSE streaming). See [../docs/api.md](../docs/api.md) and
[../docs/architecture.md](../docs/architecture.md).

## Run

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
uvicorn app.main:app --reload --host 127.0.0.1 --port 8765
```

## Health check

```bash
curl http://127.0.0.1:8765/health
# {"status":"ok","service":"storage-agent-sidecar"}
```

## Test

```bash
pip install -e ".[dev]"
pytest
```
