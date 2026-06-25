"""FastAPI sidecar entrypoint for Storage Agent Workbench.

Through Phase 05 this exposes: a local data layer (SQLite), keyring-based secret
storage, model/cloud provider CRUD, a whitelisted READ-ONLY S3-compatible tool
layer, deterministic Analysis Runs (diagnostic, access_log_analysis,
inventory_analysis) with SSE streaming, DuckDB-backed local analysis, and local
Markdown reports. There is still no agent runtime (no LLM / OpenAI Agents SDK),
no bucket config review, no generic shell execution, and no destructive/mutating
S3 operation.

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
    health,
    model_providers,
    reports,
    runs,
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
    version="0.5.0",
    description="Local-first sidecar for Storage Agent Workbench (Phase 05: DuckDB analysis).",
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
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(model_providers.router)
app.include_router(cloud_providers.router)
app.include_router(tools.router)
app.include_router(runs.router)
app.include_router(reports.router)
app.include_router(datasets.router)
