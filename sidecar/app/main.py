"""FastAPI sidecar entrypoint for Storage Agent Workbench.

This exposes: a local data layer (SQLite), keyring-based secret storage,
model/cloud provider CRUD, a whitelisted READ-ONLY S3-compatible tool layer,
deterministic Analysis Runs (diagnostic, access_log_analysis, inventory_analysis,
bucket_config_review, account_discovery) with SSE streaming, DuckDB-backed local
analysis, read-only bucket configuration review, local Markdown reports, and the
single conversational session agent (the only LLM in the product). The agent can
only call the existing whitelisted, read-only tools; it never sees credentials.
There is no auto-remediation, no generic shell execution, no MCP runtime, no
multi-agent orchestration, and no destructive/mutating S3 operation.

Security note: this service binds to localhost only (``127.0.0.1``). Secrets
submitted to provider endpoints are written to the encrypted local vault; SQLite
and logs store only ``keyring://`` references. API responses never return
plaintext secrets.

Local-process isolation: binding to ``127.0.0.1`` keeps the socket off the
network, but any *other* process on the same machine can still reach it, and CORS
does nothing against non-browser clients. So when the launcher (Tauri) provides a
shared secret via ``STORAGE_AGENT_AUTH_TOKEN``, every request must carry it (an
``X-Sidecar-Token`` header, or a ``token`` query param for the header-less SSE
``EventSource``). When the variable is unset — plain dev/browser runs and the
test suite — auth is left open so the local workflow keeps working.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from importlib import metadata

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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
    settings,
    tools,
)

SERVICE_NAME = health.SERVICE_NAME


def _service_version() -> str:
    """Resolve the packaged version rather than hardcoding it.

    Kept in lockstep with ``pyproject`` by ``scripts/stamp-version.py``; falls
    back to a sentinel when the package metadata isn't installed (e.g. running
    straight from source without ``pip install -e``).
    """
    try:
        return metadata.version("storage-agent-sidecar")
    except metadata.PackageNotFoundError:
        return "0.0.0+source"


# Shared-secret gate. Enforced only when the launcher sets the variable; unset
# means dev/test and auth stays open. Paths that must stay reachable without the
# token (liveness) are listed here.
_AUTH_TOKEN = os.environ.get("STORAGE_AGENT_AUTH_TOKEN") or None
_AUTH_EXEMPT_PATHS = {"/health"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Create the database and apply migrations on startup.
    init_db()
    # Fail any run left pending/running by a prior process — in-process run
    # threads don't survive a restart, so such rows are orphans.
    from . import run_service
    run_service.reconcile_interrupted_runs()
    yield


app = FastAPI(
    title="Storage Agent Sidecar",
    version=_service_version(),
    description="Local-first sidecar for Storage Agent Workbench.",
    lifespan=lifespan,
)


@app.middleware("http")
async def _require_sidecar_token(request: Request, call_next):
    """Reject any local caller that doesn't present the launcher's shared secret.

    No-op when ``STORAGE_AGENT_AUTH_TOKEN`` is unset (dev/test). CORS preflight
    (``OPTIONS``) and the liveness endpoint stay open so the browser handshake
    and health probes work before a token is in hand.
    """
    if _AUTH_TOKEN is not None and request.method != "OPTIONS":
        if request.url.path not in _AUTH_EXEMPT_PATHS:
            presented = request.headers.get("x-sidecar-token") or request.query_params.get("token")
            if presented != _AUTH_TOKEN:
                return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)

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
app.include_router(settings.router)
