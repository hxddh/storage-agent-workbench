"""FastAPI sidecar entrypoint for Storage Agent Workbench.

Phase 01 implements only ``GET /health``. No S3 tools, no DuckDB analysis,
no secret storage, no agent runtime. See ``docs/roadmap.md`` for the plan.

Security note: this service is intended to bind to localhost only
(``127.0.0.1``) and must never receive cloud credentials or secrets in
Phase 01. There is no generic shell execution endpoint and there are no
destructive S3 operations.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

SERVICE_NAME = "storage-agent-sidecar"

app = FastAPI(
    title="Storage Agent Sidecar",
    version="0.1.0",
    description="Local-first sidecar for Storage Agent Workbench (Phase 01: health only).",
)

# The desktop frontend runs on a localhost dev origin and talks to this
# sidecar from the browser/webview, so we allow the common local dev origins.
# Local-only by design; not intended to be exposed to the network.
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
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness probe used by the frontend to show connected/disconnected."""
    return {"status": "ok", "service": SERVICE_NAME}
