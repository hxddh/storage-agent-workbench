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

    # Local providers (ollama/lmstudio/vllm/llama.cpp) do not require an API key
    # and have a sensible localhost default base_url. Cloud providers still
    # require a key; base_url is optional for them (→ OpenAI default).
    from ..agent_runtime.agent_service import LOCAL_DEFAULT_BASE_URLS, _is_local_provider
    is_local = _is_local_provider(provider.provider_type)
    effective_base = provider.base_url or LOCAL_DEFAULT_BASE_URLS.get((provider.provider_type or "").strip().lower(), "")
    checks = {
        "has_base_url": bool(effective_base or provider.base_url),
        "has_model": bool(provider.model),
        "api_key_present": secret is not None,
        "is_local": is_local,
    }
    # Local: only model is required (key is "not-needed", base_url has default).
    # Cloud: model + key are required, base_url optional.
    if is_local:
        required = ("has_model",)
    else:
        required = ("has_model", "api_key_present")
    if not all(checks[k] for k in required):
        return ModelProviderTestResult(
            ok=False, checks=checks, api_key_verified=None,
            detail="Configuration incomplete: "
                   + ", ".join(k for k in required if not checks[k]))

    # Live probe. /models is the standard OpenAI-compatible listing endpoint;
    # providers that don't expose it still prove reachability by answering.
    # `httpx2`, not `httpx`: the OpenAI 3.x line moved to the httpx 2 major, which
    # ships under a DIFFERENT distribution name. Importing `httpx` here worked
    # only because the old SDK dragged it in transitively — after the upgrade it
    # survives solely in the dev extra, so a plain `pip install -e .` and the
    # packaged bundle would both raise ModuleNotFoundError and answer this route
    # with a 500. It is declared in `[project].dependencies` rather than taken
    # transitively from `openai`, and test_v085_runtime_imports.py holds the line.
    import httpx2
    # Resolve probe base: explicit → local default → OpenAI default.
    from ..agent_runtime.agent_service import LOCAL_DEFAULT_BASE_URLS as _LOCAL_URLS
    probe_base = provider.base_url or _LOCAL_URLS.get((provider.provider_type or "").strip().lower()) or "https://api.openai.com/v1"
    base = probe_base.rstrip("/")
    # Local providers often ignore Bearer, but some (vLLM with auth) still check —
    # send a dummy token when none is stored so the probe actually exercises the endpoint.
    probe_secret = secret or ("not-needed" if is_local else "")
    api_key_verified: bool | None = None
    live_detail = ""
    try:
        resp = httpx2.get(base + "/models", headers={"Authorization": f"Bearer {probe_secret}"}, timeout=5.0)
        checks["endpoint_reachable"] = True
        if resp.status_code in (401, 403):
            api_key_verified = False
            live_detail = "The provider rejected the API key (HTTP %d). Check the key." % resp.status_code
        elif resp.status_code == 200:
            api_key_verified = True
            live_detail = "Endpoint reachable and the API key was accepted."
        elif resp.status_code < 500:
            # 404/405 = reached but no /models (common on minimal proxies). The key
            # is NEITHER accepted nor rejected — leave it UNVERIFIED (None), not a
            # confident pass, so the UI doesn't show a false green on a wrong key.
            api_key_verified = None
            live_detail = ("Endpoint reachable, but it doesn't expose /models "
                           "(HTTP %d), so the API key could not be verified here — "
                           "it will be checked on the first real request." % resp.status_code)
        else:
            checks["server_error"] = True
            live_detail = "Endpoint reachable but returned a server error (HTTP %d)." % resp.status_code
    except Exception:  # noqa: BLE001 — network failure classes, no body echoed
        checks["endpoint_reachable"] = False
        live_detail = "Could not reach the endpoint (network error or timeout). Check the base URL."

    # ok = no hard problem detected (reachable, key not rejected, no server error).
    # A None api_key_verified still counts as ok, but the UI surfaces it as a
    # caution ("reachable, key unverified") rather than a green pass.
    ok = (checks.get("endpoint_reachable", False)
          and api_key_verified is not False
          and not checks.get("server_error", False))
    if ok:
        # v1.13 — a green probe means the endpoint works NOW: drop any
        # remembered capability refusals (usage/parallel/cache) so a fixed
        # proxy is retried instead of waiting for a Sidecar restart.
        try:
            from ..agent_runtime.session_agent import forget_endpoint_capabilities
            forget_endpoint_capabilities(
                provider.base_url or _LOCAL_URLS.get((provider.provider_type or "").strip().lower()),
                provider.model)
        except Exception:  # noqa: BLE001 — bookkeeping never fails the probe
            pass
    return ModelProviderTestResult(ok=ok, checks=checks, api_key_verified=api_key_verified,
                                   detail=live_detail)
