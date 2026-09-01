"""Skills API — list bundled + user skills, read one, manage user skills.

Read path is public; write path is local-only and validated strictly (no code
execution — SKILL.md is rendered as guidance text, never executed).

Enables the modern native agent extension: operators can drop a SKILL.md into
``STORAGE_AGENT_DATA_DIR/skills/<name>/SKILL.md`` (or ``STORAGE_AGENT_SKILLS_DIR``)
and it appears in the catalog without a code change.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..db import get_conn
from ..skills import context as skill_context
from ..skills import loader as skill_loader

router = APIRouter(prefix="/skills", tags=["skills"])

_NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{1,64}$")


@router.get("")
def list_skills(conn: sqlite3.Connection = Depends(get_conn)):  # noqa: ARG001
    """List all skills (bundled + user) with their routing descriptions."""
    items = skill_loader.load_registry()
    return {
        "skills": [
            {
                "name": m.name,
                "description": m.description,
                "maturity": m.maturity,
                "mode": m.mode,
                "domains": list(m.domains),
                "path": m.path,
            }
            for m in items
        ],
        "count": len(items),
    }


@router.get("/{name}")
def get_skill(name: str, conn: sqlite3.Connection = Depends(get_conn)):  # noqa: ARG001
    """Return one skill's frontmatter-stripped body (bounded, sanitized)."""
    if not _NAME_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail="invalid skill name")
    body = skill_context.read_skill_text(name)
    if body is None:
        raise HTTPException(status_code=404, detail="skill not found")
    meta = skill_loader.get_meta(name)
    return {
        "name": name,
        "description": meta.description if meta else "",
        "body": body,
        "truncated": len(body) >= skill_context.MAX_CHARS_PER_SKILL,
    }


@router.get("/_dirs/info")
def skills_dirs_info(conn: sqlite3.Connection = Depends(get_conn)):  # noqa: ARG001
    """Where user skills are discovered (for UI help text). No secrets."""
    from .. import config as app_config

    dirs = skill_loader._user_skills_dirs()  # type: ignore[attr-defined]
    info: list[dict[str, Any]] = []
    for d in dirs:
        try:
            exists = d.exists()
            count = 0
            if exists and d.is_dir():
                count = sum(1 for child in d.iterdir() if child.is_dir() and (child / "SKILL.md").is_file())
            info.append({"path": str(d), "exists": exists, "skill_count": count})
        except Exception:  # noqa: BLE001
            info.append({"path": str(d), "exists": False, "skill_count": 0})
    return {
        "data_dir": str(app_config.data_dir()),
        "dirs": info,
        "env_override": "STORAGE_AGENT_SKILLS_DIR",
    }
