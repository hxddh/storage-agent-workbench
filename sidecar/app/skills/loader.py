"""Load the bundled StorageOps skill pack (Phase 19).

Reads ``bundled_skillpacks/storageops/skill-registry.yaml`` + each
``skills/*/SKILL.md`` and exposes minimal metadata for selection plus the raw
SKILL.md body for context injection. It loads NO references/, templates/, or
scripts/ (those are not vendored), and it deliberately IGNORES
``recommended_tools`` for any Agent-facing purpose — those are never registered,
exposed, or executed by the Workbench.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

_PACK_ROOT = Path(__file__).resolve().parent.parent / "bundled_skillpacks" / "storageops"
_REGISTRY = _PACK_ROOT / "skill-registry.yaml"


@dataclass(frozen=True)
class SkillMeta:
    name: str
    path: str
    description: str = ""
    maturity: str = ""
    mode: str = ""
    trigger_keywords: tuple[str, ...] = ()
    domains: tuple[str, ...] = ()
    auto_route: bool = False
    priority: int = 100
    # NOTE: recommended_tools is intentionally NOT stored — it must never reach
    # the Agent prompt, the UI, or any tool registry.

    @property
    def keyword_blob(self) -> str:
        parts = [self.name, self.description, " ".join(self.trigger_keywords),
                 " ".join(self.domains)]
        return " ".join(p for p in parts if p).lower()


def pack_root() -> Path:
    return _PACK_ROOT


@lru_cache(maxsize=1)
def load_registry() -> list[SkillMeta]:
    """Parse the bundled registry into minimal, tool-free metadata."""
    if not _REGISTRY.is_file():
        return []
    data = yaml.safe_load(_REGISTRY.read_text(encoding="utf-8")) or {}
    out: list[SkillMeta] = []
    for entry in data.get("skills", []) or []:
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        out.append(SkillMeta(
            name=str(entry.get("name")),
            path=str(entry.get("path") or f"skills/{entry.get('name')}/SKILL.md"),
            description=" ".join(str(entry.get("description") or "").split()),
            maturity=str(entry.get("maturity") or ""),
            mode=str(entry.get("mode") or ""),
            trigger_keywords=tuple(str(k) for k in (entry.get("trigger_keywords") or [])),
            domains=tuple(str(d) for d in (entry.get("domains") or [])),
            auto_route=bool(entry.get("auto_route", False)),
            priority=int(entry.get("priority", 100)),
        ))
    return out


def get_meta(name: str) -> SkillMeta | None:
    for m in load_registry():
        if m.name == name:
            return m
    return None


@lru_cache(maxsize=64)
def load_skill_body(name: str) -> str | None:
    """Return the raw SKILL.md text for a skill, or None if unavailable.

    Only the bundled SKILL.md is read — never references/, templates/, scripts/.
    """
    meta = get_meta(name)
    if meta is None:
        return None
    # Resolve strictly inside the bundled pack (no path escape).
    candidate = (_PACK_ROOT / meta.path).resolve()
    if not str(candidate).startswith(str(_PACK_ROOT.resolve())):
        return None
    if candidate.name != "SKILL.md" or not candidate.is_file():
        return None
    return candidate.read_text(encoding="utf-8")


__all__ = ["SkillMeta", "load_registry", "get_meta", "load_skill_body", "pack_root"]
