"""StorageOps skill context — progressive disclosure (Agent Skills paradigm).

Skills follow the Agent Skills pattern: only their metadata (name + one-line
description) sits in the agent's context as a CATALOG; the agent loads a skill's
full method ON DEMAND via the read-only ``read_skill`` tool when it judges the
skill relevant. This avoids stuffing full bodies into every prompt and lets the
model — not a keyword matcher — choose.

Entry points:
- ``catalog_text()`` — the always-in-context list of name + description, injected
  for the live (tool-using) session agent alongside the ``read_skill`` tool.
- ``read_skill_text(name)`` — the frontmatter-stripped, bounded body the
  ``read_skill`` tool returns when the agent chooses to load a skill.

The YAML frontmatter (which carries ``recommended_tools`` and other runtime
artifacts) is stripped before any text reaches the model, and nothing is ever
executed — SKILL.md bodies are static guidance text only.
"""

from __future__ import annotations

import re

from . import loader

# Matches a leading YAML frontmatter block: a line of '---', content, then a
# closing line of '---'. The frontmatter carries recommended_tools etc., which
# must NEVER reach the Agent prompt — we replace it with a safe metadata header
# rebuilt from the loader's tool-free metadata.
_FRONTMATTER = re.compile(r"\A﻿?\s*---\s*\n.*?\n---\s*\n?", re.DOTALL)

MAX_CHARS_PER_SKILL = 8000


def strip_frontmatter(body: str) -> str:
    """Remove a leading YAML frontmatter block from a SKILL.md body, if present."""
    return _FRONTMATTER.sub("", body or "", count=1).lstrip("\n")


def _bounded(body: str, limit: int) -> str:
    body = body or ""
    if len(body) <= limit:
        return body
    return body[:limit] + "\n\n…(skill truncated for length)…"


# --- progressive disclosure (live session agent) ----------------------------


def skill_names() -> list[str]:
    """All skill names — the allow-list for what the agent may cite as used."""
    return [m.name for m in loader.load_registry()]


def catalog() -> list[dict[str, str]]:
    """The skill catalog: name + one-line description for every bundled skill."""
    return [{"name": m.name, "description": m.description} for m in loader.load_registry()]


def catalog_text() -> str:
    """The always-in-context skill catalog for the tool-using agent."""
    items = catalog()
    if not items:
        return ""
    lines = [
        "STORAGEOPS SKILLS — expert diagnostic methods available to you.",
        "Each entry is name: when-to-use. When a skill fits the user's problem, "
        "call read_skill(name) to load its full method, then apply it with your "
        "read-only tools — running a survey/review inline, or proposing a "
        "confirmed import, where the method calls for heavier analysis. You do "
        "not have to use a skill if none applies.",
        "",
    ]
    for it in items:
        lines.append(f"- {it['name']}: {it['description']}")
    return "\n".join(lines)


def read_skill_text(name: str, limit: int = MAX_CHARS_PER_SKILL) -> str | None:
    """The frontmatter-stripped, bounded body for one skill, or None if unknown.

    This is what the read-only ``read_skill`` agent tool returns. No execution,
    no references/scripts — only the bundled SKILL.md guidance text.
    """
    raw = loader.load_skill_body(name)
    if not raw:
        return None
    return _bounded(strip_frontmatter(raw), limit)


__all__ = [
    "strip_frontmatter", "skill_names", "catalog", "catalog_text", "read_skill_text",
    "MAX_CHARS_PER_SKILL",
]
