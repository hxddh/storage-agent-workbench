"""Health endpoint."""

from __future__ import annotations

from fastapi import APIRouter

SERVICE_NAME = "storage-agent-sidecar"

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    """Liveness probe used by the frontend to show connected/disconnected."""
    return {"status": "ok", "service": SERVICE_NAME}
