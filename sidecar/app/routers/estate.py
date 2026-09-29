"""The storage estate (v4.0): buckets, issues and their lifecycle.

Reads are projections of what the deterministic engines recorded. The only
writes are the issue's own lifecycle: generate a fix (text the user applies —
storage stays read-only), a read-only re-check, and accepting a risk. No route
here submits Agent work; tasks keep the one submit path.
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..db import get_conn
from ..estate import store, verify

router = APIRouter(tags=["estate"])


def _lang(lang: str | None) -> str:
    return "zh" if str(lang or "").lower().startswith("zh") else "en"


@router.get("/estate")
def get_estate(lang: str | None = None, conn: sqlite3.Connection = Depends(get_conn)):
    return store.overview(conn, _lang(lang))


@router.get("/issues")
def list_issues(status: str = Query("active"), provider_id: str | None = None,
                limit: int = Query(200, ge=1, le=500), lang: str | None = None,
                conn: sqlite3.Connection = Depends(get_conn)):
    if status not in ("active", "care", "all", *store.STATUSES):
        raise HTTPException(422, "unknown status")
    return store.list_issues(conn, status=status, provider_id=provider_id, limit=limit,
                             lang=_lang(lang))


@router.get("/issues/{issue_id}")
def get_issue(issue_id: str, lang: str | None = None, conn: sqlite3.Connection = Depends(get_conn)):
    issue = store.get_issue(conn, issue_id, _lang(lang))
    if issue is None:
        raise HTTPException(404, "issue not found")
    return issue


@router.post("/issues/{issue_id}/fix")
def propose_fix(issue_id: str, lang: str | None = None, conn: sqlite3.Connection = Depends(get_conn)):
    if store.get_issue(conn, issue_id) is None:
        raise HTTPException(404, "issue not found")
    if store.propose_fix(conn, issue_id) is None:
        raise HTTPException(409, "no generated fix for this issue")
    return store.get_issue(conn, issue_id, _lang(lang))


@router.post("/issues/{issue_id}/verify")
def verify_issue(issue_id: str, lang: str | None = None, conn: sqlite3.Connection = Depends(get_conn)):
    if store.get_issue(conn, issue_id) is None:
        raise HTTPException(404, "issue not found")
    try:
        out = verify.verify_issue(conn, issue_id)
    except verify.VerifyError as exc:
        raise HTTPException(409, str(exc)) from exc
    out["issue"] = store.get_issue(conn, issue_id, _lang(lang))
    return out


class AcceptBody(BaseModel):
    accepted: bool = True


@router.post("/issues/{issue_id}/accept")
def accept_issue(issue_id: str, body: AcceptBody, lang: str | None = None,
                 conn: sqlite3.Connection = Depends(get_conn)):
    if not store.set_accepted(conn, issue_id, body.accepted):
        raise HTTPException(404, "issue not found")
    return store.get_issue(conn, issue_id, _lang(lang))


# --- proactive watch (opt-in per cloud provider, off by default) -------------

class WatchBody(BaseModel):
    enabled: bool
    interval_hours: int = 24


def _provider_or_404(conn: sqlite3.Connection, provider_id: str) -> None:
    from ..repositories import cloud_providers as cloud_repo
    if cloud_repo.get(conn, provider_id) is None:
        raise HTTPException(404, "cloud provider not found")


@router.get("/estate/watch/{provider_id}")
def get_watch(provider_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    from ..estate import watch
    _provider_or_404(conn, provider_id)
    return {**watch.get(conn, provider_id), "running": watch.is_running(provider_id)}


@router.put("/estate/watch/{provider_id}")
def put_watch(provider_id: str, body: WatchBody, conn: sqlite3.Connection = Depends(get_conn)):
    from ..estate import watch
    _provider_or_404(conn, provider_id)
    out = watch.set_watch(conn, provider_id, enabled=body.enabled, interval_hours=body.interval_hours)
    return {**out, "running": watch.is_running(provider_id)}


@router.post("/estate/watch/{provider_id}/run", status_code=202)
def run_watch(provider_id: str, conn: sqlite3.Connection = Depends(get_conn)):
    """Check now: one read-only sweep in the background (one at a time per
    provider). It runs even when the watch is off — the user asked."""
    from ..estate import watch
    _provider_or_404(conn, provider_id)
    return {"started": watch.run_now(provider_id)}
