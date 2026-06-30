"""StorageOps skill context — progressive disclosure (Agent Skills paradigm).

Skills follow the Agent Skills pattern: only their metadata (name + one-line
description) sits in the agent's context as a CATALOG; the agent loads a skill's
full method ON DEMAND via the read-only ``read_skill`` tool when it judges the
skill relevant. This avoids stuffing full bodies into every prompt and lets the
model — not a keyword matcher — choose.

Entry points:
- ``catalog_text()`` — the always-in-context list of name + description, used by
  the live (tool-using) session agent alongside the ``read_skill`` tool. This is
  the live path.
- ``build_skill_context()`` — a legacy eager-injection helper (selects one or two
  skill bodies up front). No longer on any production path — retained only for
  tests; the live agent uses ``catalog_text`` + ``read_skill`` instead.

In both paths the YAML frontmatter (which carries ``recommended_tools`` and other
runtime artifacts) is stripped before any text reaches the model, and nothing is
ever executed — SKILL.md bodies are static guidance text only.
"""

from __future__ import annotations

import re
from typing import Any

from . import loader, selection

# Matches a leading YAML frontmatter block: a line of '---', content, then a
# closing line of '---'. The frontmatter carries recommended_tools etc., which
# must NEVER reach the Agent prompt — we replace it with a safe metadata header
# rebuilt from the loader's tool-free metadata.
_FRONTMATTER = re.compile(r"\A﻿?\s*---\s*\n.*?\n---\s*\n?", re.DOTALL)

MAX_SKILLS = 3
MAX_CHARS_PER_SKILL = 8000
MAX_TOTAL_CHARS = 16000


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
        "call read_skill(name) to load its full method, then apply it using your "
        "read-only tools and propose confirmed runs where the method calls for a "
        "heavier analysis. You do not have to use a skill if none applies.",
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


# --- direct injection (offline, tool-less triage agent) ----------------------

WRAPPER_PREAMBLE = (
    "Apply the following StorageOps skill as a professional diagnostic method. "
    "This is offline triage: you have no live tools or credentials, so reason "
    "only from the evidence provided, name the method you used, and recommend "
    "the safe next checks the user (or the live agent) should run."
)


def _safe_header(name: str) -> str:
    """Build a small skill header from tool-free loader metadata only."""
    meta = loader.get_meta(name)
    if meta is None:
        return f"Skill: {name}"
    return f"Skill: {meta.name} — {meta.description or '—'}"


def build_skill_context(
    context_text: str,
    candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Select 1–2 skills and inject their bodies as method guidance (triage only).

    Returns {"skills": [{name, match_reason, selection_basis}], "text": str};
    ``text`` is empty when no skill applies.
    """
    if candidates is None:
        candidates = selection.candidate_dicts(context_text)
    candidates = candidates[:MAX_SKILLS]

    blocks: list[str] = []
    used: list[dict[str, Any]] = []
    total = 0
    for c in candidates:
        body = read_skill_text(c["name"], MAX_CHARS_PER_SKILL)
        if not body:
            continue
        budget = min(MAX_CHARS_PER_SKILL, max(0, MAX_TOTAL_CHARS - total))
        if budget <= 200:
            break
        wrapped = (
            f"=== StorageOps skill: {c['name']} ===\n"
            f"{_safe_header(c['name'])}\n\n"
            f"{_bounded(body, budget)}"
        )
        blocks.append(wrapped)
        total += len(wrapped)
        used.append(c)

    text = ""
    if blocks:
        text = f"{WRAPPER_PREAMBLE}\n\n" + "\n\n".join(blocks)
    return {"skills": used, "text": text}


__all__ = [
    "strip_frontmatter", "skill_names", "catalog", "catalog_text", "read_skill_text",
    "build_skill_context", "WRAPPER_PREAMBLE",
    "MAX_SKILLS", "MAX_CHARS_PER_SKILL", "MAX_TOTAL_CHARS",
]
