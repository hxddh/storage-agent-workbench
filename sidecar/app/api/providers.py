"""Model endpoints and storage accounts. Secrets go in, never come out."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response

from ..agent import models as agent_models
from ..agent.tools.registry import run_direct
from ..core import store
from ..db import get_conn
from ..estate import watch
from ..providers import clouds, models
from ..s3 import tools as s3_tools

router = APIRouter(prefix="/providers", tags=["providers"])


# --- models ------------------------------------------------------------------------------

@router.get("/models")
def list_models(conn: Any = Depends(get_conn)) -> list[dict[str, Any]]:
    return models.list_all(conn)


@router.post("/models", status_code=status.HTTP_201_CREATED)
def create_model(body: models.ModelProviderIn, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    out = models.create(conn, body)
    store.audit(conn, actor="user", action="model_provider.create", target=out["id"])
    return out


@router.patch("/models/{provider_id}")
def update_model(provider_id: str, body: models.ModelProviderPatch, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    out = models.update(conn, provider_id, body)
    if out is None:
        raise HTTPException(status_code=404, detail="model provider not found")
    store.audit(conn, actor="user", action="model_provider.update", target=provider_id)
    return out


@router.delete("/models/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model(provider_id: str, conn: Any = Depends(get_conn)) -> Response:
    if not models.delete(conn, provider_id):
        raise HTTPException(status_code=404, detail="model provider not found")
    store.audit(conn, actor="user", action="model_provider.delete", target=provider_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/models/{provider_id}/activate")
def activate_model(provider_id: str, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    if not models.activate(conn, provider_id):
        raise HTTPException(status_code=404, detail="model provider not found")
    return models.get(conn, provider_id)  # type: ignore[return-value]


@router.post("/models/{provider_id}/test")
def test_model(provider_id: str, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    """A bounded live probe (GET {base}/models, 5 s). No response body is echoed."""
    if models.get(conn, provider_id) is None:
        raise HTTPException(status_code=404, detail="model provider not found")
    try:
        creds = models.credentials(conn, provider_id)
    except models.AgentUnavailable as exc:
        return {"ok": False, "api_key_verified": None, "detail": str(exc)}
    import httpx2
    try:
        resp = httpx2.get(str(creds["base_url"] or "https://api.openai.com/v1").rstrip("/") + "/models",
                          headers={"Authorization": f"Bearer {creds['api_key']}"}, timeout=5.0)
    except Exception:  # noqa: BLE001 — network classes; nothing echoed
        return {"ok": False, "api_key_verified": None,
                "detail": "Could not reach the endpoint (network error or timeout). Check the base URL."}
    code = resp.status_code
    if code in (401, 403):
        return {"ok": False, "api_key_verified": False, "detail": f"The endpoint rejected the API key (HTTP {code})."}
    if code >= 500:
        return {"ok": False, "api_key_verified": None, "detail": f"The endpoint returned a server error (HTTP {code})."}
    agent_models.forget_refusals(creds)
    if code == 200:
        return {"ok": True, "api_key_verified": True, "detail": "Endpoint reachable and the key was accepted."}
    return {"ok": True, "api_key_verified": None,
            "detail": f"Endpoint reachable but it has no /models (HTTP {code}); the key is checked on first use."}


# --- storage accounts -----------------------------------------------------------------

@router.get("/clouds")
def list_clouds(conn: Any = Depends(get_conn)) -> list[dict[str, Any]]:
    return [c.public() | {"watch": watch.get(conn, c.id)} for c in clouds.list_all(conn)]


@router.post("/clouds", status_code=status.HTTP_201_CREATED)
def create_cloud(body: clouds.CloudIn, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    out = clouds.create(conn, body).public()
    store.audit(conn, actor="user", action="cloud_provider.create", target=out["id"])
    return out


@router.patch("/clouds/{provider_id}")
def update_cloud(provider_id: str, body: clouds.CloudPatch, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    out = clouds.update(conn, provider_id, body)
    if out is None:
        raise HTTPException(status_code=404, detail="cloud provider not found")
    store.audit(conn, actor="user", action="cloud_provider.update", target=provider_id)
    return out.public()


@router.delete("/clouds/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cloud(provider_id: str, conn: Any = Depends(get_conn)) -> Response:
    if not clouds.delete(conn, provider_id):
        raise HTTPException(status_code=404, detail="cloud provider not found")
    store.audit(conn, actor="user", action="cloud_provider.delete", target=provider_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/clouds/{provider_id}/test")
def test_cloud(provider_id: str, conn: Any = Depends(get_conn)) -> dict[str, Any]:
    """A read-only credential check, audited like any tool call."""
    if clouds.get(conn, provider_id) is None:
        raise HTTPException(status_code=404, detail="cloud provider not found")
    return run_direct(conn, "test_credentials", {"provider_id": provider_id},
                      lambda: s3_tools.test_credentials(conn, provider_id), actor="user")
