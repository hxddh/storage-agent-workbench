"""Model provider CRUD + connectivity test."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Response, status

from ..db import get_conn
from ..models.schemas import (
    ModelProviderCreate,
    ModelProviderOut,
    ModelProviderTestResult,
    ModelProviderUpdate,
)
from ..repositories import model_providers as repo
from ..security import keyring_store

router = APIRouter(prefix="/model-providers", tags=["model-providers"])


@router.get("", response_model=list[ModelProviderOut])
def list_model_providers(conn: sqlite3.Connection = Depends(get_conn)):
    return repo.list_all(conn)


@router.post("", response_model=ModelProviderOut, status_code=status.HTTP_201_CREATED)
def create_model_provider(
    body: ModelProviderCreate, conn: sqlite3.Connection = Depends(get_conn)
):
    return repo.create(conn, body)


@router.put("/{provider_id}", response_model=ModelProviderOut)
def update_model_provider(
    provider_id: str,
    body: ModelProviderUpdate,
    conn: sqlite3.Connection = Depends(get_conn),
):
    result = repo.update(conn, provider_id, body)
    if result is None:
        raise HTTPException(status_code=404, detail="model provider not found")
    return result


@router.delete("/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model_provider(
    provider_id: str, conn: sqlite3.Connection = Depends(get_conn)
):
    if not repo.delete(conn, provider_id):
        raise HTTPException(status_code=404, detail="model provider not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{provider_id}/activate", response_model=ModelProviderOut)
def activate_model_provider(
    provider_id: str, conn: sqlite3.Connection = Depends(get_conn)
):
    """Select the model provider the agent uses.

    With several providers configured, the agent previously always used the
    oldest one (adding a second provider silently did nothing). Activation makes
    the selection explicit; with no explicit selection the oldest remains the
    default, so existing single-provider installs behave unchanged.
    """
    if not repo.set_active(conn, provider_id):
        raise HTTPException(status_code=404, detail="model provider not found")
    return repo.get(conn, provider_id)


@router.post("/{provider_id}/test", response_model=ModelProviderTestResult)
def test_model_provider(
    provider_id: str, conn: sqlite3.Connection = Depends(get_conn)
):
    """Validate that a model provider is configured — and actually reachable.

    Config check (fields set, key resolves from the vault) plus a bounded LIVE
    probe: GET {base_url}/models with the key, 5s timeout. A config-only "test"
    passed invalid keys and let the first real turn fail instead. The probe
    classifies: key accepted / key rejected / endpoint unreachable / endpoint
    doesn't expose /models (config ok, auth unverified). The secret value is
    resolved server-side only and never returned; no response body is echoed.
    """
    provider = repo.get(conn, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="model provider not found")

    secret: str | None = None
    if provider.api_key_ref:
        scope, name = keyring_store.parse_ref(provider.api_key_ref)
        secret = keyring_store.get_secret(scope, name)

    checks = {
        "has_base_url": bool(provider.base_url),
        "has_model": bool(provider.model),
        "api_key_present": secret is not None,
    }
    config_ok = all(checks.values())
    if not config_ok:
        return ModelProviderTestResult(
            ok=False, checks=checks,
            detail="Configuration incomplete: "
                   + ", ".join(k for k, v in checks.items() if not v))

    # Live probe. /models is the standard OpenAI-compatible listing endpoint;
    # providers that don't expose it still prove reachability by answering.
    import httpx
    live_detail = ""
    try:
        url = provider.base_url.rstrip("/") + "/models"
        resp = httpx.get(url, headers={"Authorization": f"Bearer {secret}"}, timeout=5.0)
        if resp.status_code in (401, 403):
            checks["api_key_accepted"] = False
            live_detail = "The provider rejected the API key (HTTP %d). Check the key." % resp.status_code
        elif resp.status_code < 500:
            # 200 = key accepted; 404/405 = endpoint reached but no /models
            # (common on minimal proxies) — reachable, auth not disproven.
            checks["endpoint_reachable"] = True
            if resp.status_code == 200:
                checks["api_key_accepted"] = True
                live_detail = "Endpoint reachable and the API key was accepted."
            else:
                live_detail = ("Endpoint reachable; it doesn't expose /models "
                               "(HTTP %d), so the key wasn't verified." % resp.status_code)
        else:
            checks["endpoint_reachable"] = True
            live_detail = "Endpoint reachable but returned a server error (HTTP %d)." % resp.status_code
    except Exception:  # noqa: BLE001 — network failure classes, no body echoed
        checks["endpoint_reachable"] = False
        live_detail = "Could not reach the endpoint (network error or timeout). Check the base URL."

    ok = config_ok and checks.get("api_key_accepted", True) and checks.get("endpoint_reachable", True)
    return ModelProviderTestResult(ok=ok, checks=checks, detail=live_detail)
