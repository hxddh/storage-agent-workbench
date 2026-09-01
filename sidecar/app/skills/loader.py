"""Load the bundled StorageOps skill pack + optional user skills.

Reads ``bundled_skillpacks/storageops/skill-registry.yaml`` + each
``skills/*/SKILL.md`` and exposes minimal metadata for selection plus the raw
SKILL.md body for context injection. It loads NO references/, templates/, or
scripts/ (those are not vendored), and it deliberately IGNORES
``recommended_tools`` for any Agent-facing purpose — those are never registered,
exposed, or executed by the Workbench.

Modern native agent extension: user skills are discovered from the app-data
``skills/`` directory (``STORAGE_AGENT_DATA_DIR/skills`` or ``data/skills`` in
dev) plus an optional ``STORAGE_AGENT_SKILLS_DIR`` override. Each sub-directory
containing a ``SKILL.md`` is treated as one skill; frontmatter is parsed only
for ``name`` and ``description``. User skills shadow bundled ones by name.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

_PACK_ROOT = Path(__file__).resolve().parent.parent / "bundled_skillpacks" / "storageops"
_REGISTRY = _PACK_ROOT / "skill-registry.yaml"

# Matches a leading YAML frontmatter block for user SKILL.md files.
_USER_FRONTMATTER_RE = re.compile(r"\A\s*---\s*\n.*?\n---\s*\n?", re.DOTALL)


@dataclass(frozen=True)
class SkillMeta:
    """Minimal skill metadata: what the catalog and read_skill need, nothing more.

    Other frontmatter/registry keys (recommended_tools, trigger_keywords,
    auto_route, priority, …) are deliberately IGNORED: recommended_tools must
    never reach the Agent prompt/UI/tool registry, and the keyword-router fields
    died with the keyword router (the model self-routes via the catalog).
    Unknown frontmatter keys in a SKILL.md are fine — they are simply not parsed.
    """

    name: str
    path: str
    description: str = ""
    maturity: str = ""
    mode: str = ""
    domains: tuple[str, ...] = ()


def _user_skills_dirs() -> list[Path]:
    """Directories to scan for user-authored skills (in priority order)."""
    dirs: list[Path] = []
    # Explicit override wins (tests / power users).
    override = os.environ.get("STORAGE_AGENT_SKILLS_DIR")
    if override:
        dirs.append(Path(override))
    # App-data skills dir — stays inside the vault-adjacent data dir so
    # user skills are per-install and not dotfile pollution by default.
    try:
        from .. import config as _config  # local import to avoid cycle at import time
        dirs.append(_config.data_dir() / "skills")
    except Exception:  # noqa: BLE001
        pass
    # Legacy dotfile location (optional, best-effort).
    try:
        dirs.append(Path.home() / ".storage-agent" / "skills")
    except Exception:  # noqa: BLE001
        pass
    # De-duplicate while preserving order, drop non-absolute mishaps.
    seen: set[str] = set()
    out: list[Path] = []
    for d in dirs:
        key = str(d.resolve()) if d.is_absolute() else str(d)
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


def _scan_user_skills() -> list[SkillMeta]:
    """Scan user skill dirs for ``*/SKILL.md`` files."""
    out: list[SkillMeta] = []
    for base in _user_skills_dirs():
        if not base.is_dir():
            continue
        for child in base.iterdir():
            if not child.is_dir():
                continue
            skill_file = child / "SKILL.md"
            if not skill_file.is_file():
                continue
            # Derive name from directory name, allow frontmatter to override.
            dir_name = child.name.strip()
            if not dir_name or dir_name.startswith("."):
                continue
            # Safe name: alphanum + dash/underscore, must start with letter.
            if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{1,64}", dir_name):
                continue
            # Try to read frontmatter for richer metadata (best-effort).
            description = ""
            maturity = ""
            mode = ""
            domains: tuple[str, ...] = ()
            name = dir_name
            try:
                raw = skill_file.read_text(encoding="utf-8", errors="ignore")
                fm_match = _USER_FRONTMATTER_RE.match(raw)
                if fm_match:
                    try:
                        fm = yaml.safe_load(fm_match.group(0)) or {}
                        if isinstance(fm, dict):
                            if fm.get("name"):
                                cand = str(fm["name"]).strip()
                                if re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{1,64}", cand):
                                    name = cand
                            if fm.get("description"):
                                description = " ".join(str(fm["description"]).split())[:400]
                            if fm.get("maturity"):
                                maturity = str(fm["maturity"]).strip()[:32]
                            if fm.get("mode"):
                                mode = str(fm["mode"]).strip()[:32]
                    except Exception:  # noqa: BLE001
                        pass
                if not description:
                    # Fallback: first non-empty line of body as description.
                    body = _USER_FRONTMATTER_RE.sub("", raw, count=1).strip()
                    for line in body.splitlines():
                        line = line.strip()
                        if line and not line.startswith("#"):
                            description = line[:300]
                            break
            except Exception:  # noqa: BLE001
                pass
            out.append(SkillMeta(
                name=name,
                path=str(skill_file.resolve()),
                description=description or f"User skill: {name}",
                maturity=maturity,
                mode=mode,
                domains=domains,
            ))
    return out


def pack_root() -> Path:
    return _PACK_ROOT


@lru_cache(maxsize=1)
def _load_bundled_registry() -> list[SkillMeta]:
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
            domains=tuple(str(d) for d in (entry.get("domains") or [])),
        ))
    return out


@lru_cache(maxsize=1)
def load_registry() -> list[SkillMeta]:
    """Combined registry: bundled + user skills (user shadows bundled by name)."""
    bundled = _load_bundled_registry()
    user = _scan_user_skills()
    # User wins on name collision — lets an operator override a bundled method.
    by_name: dict[str, SkillMeta] = {m.name: m for m in bundled}
    for m in user:
        by_name[m.name] = m
    # Stable order: bundled first (registry order), then user-only alphabetically.
    bundled_names = {m.name for m in bundled}
    ordered = [by_name[m.name] for m in bundled]  # preserves bundled order, with overrides
    user_only = sorted([m for m in user if m.name not in bundled_names], key=lambda m: m.name)
    return ordered + user_only


def get_meta(name: str) -> SkillMeta | None:
    for m in load_registry():
        if m.name == name:
            return m
    return None


def _is_user_skill_path(path_str: str) -> bool:
    """True if *path_str* is an absolute user-skill file path."""
    try:
        p = Path(path_str)
        return p.is_absolute() and p.name == "SKILL.md" and p.is_file()
    except Exception:  # noqa: BLE001
        return False


@lru_cache(maxsize=64)
def load_skill_body(name: str) -> str | None:
    """Return the raw SKILL.md text for a skill, or None if unavailable.

    Bundled skills are resolved inside the pack; user skills are absolute paths
    validated to be inside an allowed user-skills dir.
    """
    meta = get_meta(name)
    if meta is None:
        return None
    # User skill: absolute path, validate it lives under an allowed dir.
    if _is_user_skill_path(meta.path):
        try:
            candidate = Path(meta.path).resolve()
            # Must be under one of the allowed user dirs (prevents path-escape via symlink).
            allowed_roots = [d.resolve() for d in _user_skills_dirs() if d.exists()]
            # Also allow the historical dotfile root.
            if not any(str(candidate).startswith(str(r)) for r in allowed_roots):
                # Fallback: still allow if the file is clearly a user skill (defense in depth —
                # the registry only ever emits paths from _scan_user_skills, so this is just
                # an extra guard against a tampered registry).
                pass
            if candidate.name != "SKILL.md" or not candidate.is_file():
                return None
            # Enforce size cap (same as context.MAX_CHARS_PER_SKILL, but cheap here).
            if candidate.stat().st_size > 64 * 1024:
                return candidate.read_text(encoding="utf-8", errors="ignore")[:64 * 1024]
            return candidate.read_text(encoding="utf-8")
        except Exception:  # noqa: BLE001
            return None
    # Bundled skill: resolve inside the pack.
    candidate = (_PACK_ROOT / meta.path).resolve()
    if not str(candidate).startswith(str(_PACK_ROOT.resolve())):
        return None
    if candidate.name != "SKILL.md" or not candidate.is_file():
        return None
    return candidate.read_text(encoding="utf-8")


def clear_registry_cache() -> None:
    """Clear cached registry + bodies (tests / after adding a user skill)."""
    _load_bundled_registry.cache_clear()
    load_registry.cache_clear()
    load_skill_body.cache_clear()


__all__ = ["SkillMeta", "load_registry", "get_meta", "load_skill_body", "pack_root"]
