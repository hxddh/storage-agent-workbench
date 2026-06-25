"""FastAPI sidecar entrypoint for Storage Agent Workbench.

Phase 02 adds a local data layer (SQLite), keyring-based secret storage, and
model/cloud provider CRUD. There are still no S3 tools, no DuckDB analysis, no
agent runtime, and no generic shell execution.

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
from .routers import cloud_providers, health, model_providers

SERVICE_NAME = health.SERVICE_NAME


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Create the database and apply migrations on startup.
    init_db()
    yield


app = FastAPI(
    title="Storage Agent Sidecar",
    version="0.2.0",
    description="Local-first sidecar for Storage Agent Workbench (Phase 02: providers).",
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
