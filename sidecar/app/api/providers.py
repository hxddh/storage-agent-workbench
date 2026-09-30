"""Model endpoints and storage accounts. Secrets go in, never come out."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response

from ..agent import budget, errors
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
    """A bounded live probe. Reachability (GET {base}/models, 4 s); once reachable,
    ONE tiny chat call with one trivial tool (7 s) that says whether a structured
    tool call comes back; for Ollama, the model's context length from /api/show
    (1.5 s). No response body is echoed; the key only ever goes in a header."""
    if models.get(conn, provider_id) is None:
        raise HTTPException(status_code=404, detail="model provider not found")
    try:
        creds = models.credentials(conn, provider_id)
    except models.AgentUnavailable as exc:
        return {"ok": False, "api_key_verified": None, "detail": str(exc)}
    import httpx2
    base = str(creds["base_url"] or "https://api.openai.com/v1").rstrip("/")
    try:
        resp = httpx2.get(base + "/models", headers={"Authorization": f"Bearer {creds['api_key']}"},
                          timeout=_REACH_TIMEOUT_S)
    except Exception:  # noqa: BLE001 — network classes; nothing echoed
        return {"ok": False, "api_key_verified": None,
                "detail": "Could not reach the endpoint (network error or timeout). Check the base URL."}
    code = resp.status_code
    if code in (401, 403):
        return {"ok": False, "api_key_verified": False, "detail": f"The endpoint rejected the API key (HTTP {code})."}
    if code >= 500:
        return {"ok": False, "api_key_verified": None, "detail": f"The endpoint returned a server error (HTTP {code})."}
    agent_models.forget_refusals(creds)
    out: dict[str, Any] = (
        {"ok": True, "api_key_verified": True, "detail": "Endpoint reachable and the key was accepted."}
        if code == 200 else
        {"ok": True, "api_key_verified": None,
         "detail": f"Endpoint reachable but it has no /models (HTTP {code}); the key is checked on first use."})
    plan = budget.plan(creds)
    out["planned_window"] = plan.window
    notes: list[str] = []
    if creds.get("kind") == "ollama":
        out["model_context"] = _ollama_context(base, creds["model"])
        if out["model_context"] and out["model_context"] < plan.window:
            notes.append(f"The model supports {out['model_context']:,} tokens of context but {plan.window:,} are "
                         f"planned: set its context window to {out['model_context']:,} in Settings › Models.")
    out["tool_calling"], note = _probe_tool_call(creds, plan)
    out["detail"] = " ".join([out["detail"], note, *notes])
    return out


_REACH_TIMEOUT_S = 4.0
_TOOL_PROBE_TIMEOUT_S = 7.0
_SHOW_TIMEOUT_S = 1.5
_PROBE_TOOL = {"type": "function", "function": {
    "name": "report_ready", "description": "Report that you are ready.",
    "parameters": {"type": "object", "properties": {"ready": {"type": "boolean"}}, "required": ["ready"]}}}


def _probe_tool_call(creds: dict[str, Any], plan: budget.Plan) -> tuple[bool | None, str]:
    """(tool_calling, sentence): True when a structured tool call came back,
    False when the model answered in text, None when it could not be asked."""
    import openai

    kwargs: dict[str, Any] = {"api_key": creds["api_key"], "timeout": _TOOL_PROBE_TIMEOUT_S, "max_retries": 0}
    if creds.get("base_url"):
        kwargs["base_url"] = creds["base_url"]
    extra: dict[str, Any] = {}
    if creds.get("kind") == "ollama":
        extra["extra_body"] = {"options": {"num_ctx": plan.window}}  # the context the Agent will ask for
    client = openai.OpenAI(**kwargs)
    try:
        r = client.chat.completions.create(
            model=creds["model"], max_tokens=128, tools=[_PROBE_TOOL],  # type: ignore[list-item]
            messages=[{"role": "user", "content": "Call the report_ready tool with ready set to true."}], **extra)
    except Exception as exc:  # noqa: BLE001 — reported as a sentence, never a body or a key
        if "timeout" in type(exc).__name__.lower():
            return None, (f"The tool-call check got no answer within {_TOOL_PROBE_TIMEOUT_S:.0f} s "
                          "(a local model may still be loading); try again.")
        return None, "The tool-call check failed. " + errors.user_message(exc)[:200]
    finally:
        client.close()
    msg = r.choices[0].message if r.choices else None
    calls = list(getattr(msg, "tool_calls", None) or [])
    if any(getattr(getattr(c, "function", None), "name", "") == "report_ready" for c in calls):
        return True, "Tool calling works: the model returned a structured tool call."
    return False, ("The model answered in text instead of a structured tool call: the Agent needs tool "
                   "calling (choose a model or server setting with tool support).")


def _ollama_context(base: str, model: str) -> int | None:
    """The model's context length from Ollama's /api/show, when reachable."""
    import httpx2
    root = base[:-3] if base.endswith("/v1") else base
    try:
        resp = httpx2.post(root + "/api/show", json={"model": model, "name": model}, timeout=_SHOW_TIMEOUT_S)
        info = (resp.json().get("model_info") or {}) if resp.status_code == 200 else {}
    except Exception:  # noqa: BLE001 — optional: an older server or a proxy
        return None
    lengths = [int(v) for k, v in info.items() if str(k).endswith(".context_length") and str(v).isdigit()]
    return min(lengths) if lengths else None


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
