"""FastAPI sidecar entrypoint for Storage Agent Workbench.

Through Phase 06 this exposes: a local data layer (SQLite), keyring-based secret
storage, model/cloud provider CRUD, a whitelisted READ-ONLY S3-compatible tool
layer, deterministic Analysis Runs (diagnostic, access_log_analysis,
inventory_analysis, bucket_config_review) with SSE streaming, DuckDB-backed local
analysis, read-only bucket configuration review, local Markdown reports, and an
OPTIONAL controlled LLM agent planner mode (deterministic remains the default).
The agent can only call the existing whitelisted, read-only tools through the
shared tool runner; it never sees credentials. There is still no auto-remediation,
no generic shell execution, no MCP runtime, no multi-agent orchestration, and no
destructive/mutating S3 operation.

Security note: this service binds to localhost only (``127.0.0.1``). Secrets
submitted to provider endpoints are written to the system keyring; SQLite and
logs store only ``keyring://`` references. API responses never return plaintext
secrets.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import init_db
from .routers import (
    cloud_providers,
    datasets,
    error_triage,
    evidence_imports,
    health,
    model_providers,
    reports,
    runs,
    sessions,
    tools,
)

SERVICE_NAME = health.SERVICE_NAME


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Create the database and apply migrations on startup.
    init_db()
    yield


app = FastAPI(
    title="Storage Agent Sidecar",
    version="0.7.0",
    description="Local-first sidecar for Storage Agent Workbench (Phase 07: agent planner mode).",
    lifespan=lifespan,
)

# Local dev origins only; not intended to be exposed to the network.
_ALLOWED_ORIGINS = [
    "http://localhost:1420",  # Tauri v2 default dev origin
    "http://127.0.0.1:1420",
    "http://localhost:5173",  # Vite default dev origin
    "http://127.0.0.1:5173",
    "tauri://localhost",      # Tauri production webview origin
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(model_providers.router)
app.include_router(cloud_providers.router)
app.include_router(tools.router)
app.include_router(runs.router)
app.include_router(reports.router)
app.include_router(datasets.router)
app.include_router(evidence_imports.router)
app.include_router(sessions.router)
app.include_router(error_triage.router)
