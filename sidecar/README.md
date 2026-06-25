# Storage Agent Sidecar

Local-only FastAPI sidecar for Storage Agent Workbench.

Phase 01 scope: a single `GET /health` endpoint. No S3 tools, no DuckDB
analysis, no keyring logic, no provider CRUD, no agent runtime.

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
