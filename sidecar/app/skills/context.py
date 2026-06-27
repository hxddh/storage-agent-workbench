"""Build bounded, tools-disabled StorageOps skill context (Phase 19).

Wraps the selected SKILL.md docs in a safety preamble that makes clear the
StorageOps tools / helper scripts / CLI / Pi runtime / external execution are
DISABLED in this Workbench phase, and that script/tool mentions inside the skill
text are conceptual guidance only. Output is bounded by a max-char budget and a
1–3 skill cap. No references/scripts/raw logs/secrets/credentials/CoT are ever
included (SKILL.md docs are static guidance text only).
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


def strip_frontmatter(body: str) -> str:
    """Remove a leading YAML frontmatter block from a SKILL.md body, if present."""
    return _FRONTMATTER.sub("", body or "", count=1).lstrip("\n")


def _safe_header(name: str) -> str:
    """Build a small skill header from tool-free loader metadata only."""
    meta = loader.get_meta(name)
    if meta is None:
        return f"Skill metadata:\n- name: {name}"
    lines = [
        "Skill metadata:",
        f"- name: {meta.name}",
        f"- description: {meta.description or '—'}",
        f"- domains: {', '.join(meta.domains) or '—'}",
        f"- mode: {meta.mode or '—'}",
        f"- maturity: {meta.maturity or '—'}",
    ]
    return "\n".join(lines)

MAX_SKILLS = 3
MAX_CHARS_PER_SKILL = 6000
MAX_TOTAL_CHARS = 14000

WRAPPER_PREAMBLE = (
    "The following StorageOps skill is provided as professional diagnostic "
    "guidance only.\n"
    "StorageOps tools, helper scripts, CLI commands, Pi runtime, and external "
    "execution are disabled in this Workbench phase.\n"
    "Do not claim to run tools or scripts.\n"
    "Do not instruct the app to execute scripts.\n"
    "Use script/tool mentions only as conceptual diagnostic guidance.\n"
    "If evidence is missing, ask the user or propose an existing safe Workbench "
    "next action."
)


def _bounded(body: str, limit: int) -> str:
    body = body or ""
    if len(body) <= limit:
        return body
    return body[:limit] + "\n\n…(skill truncated for length)…"


def build_skill_context(
    context_text: str,
    candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Select skills (unless provided) and assemble bounded, wrapped context.

    Returns {"skills": [{name, match_reason, selection_basis}], "text": str}.
    ``text`` is empty when no skill applies.
    """
    if candidates is None:
        candidates = selection.candidate_dicts(context_text)
    candidates = candidates[:MAX_SKILLS]

    blocks: list[str] = []
    used: list[dict[str, Any]] = []
    total = 0
    for c in candidates:
        raw = loader.load_skill_body(c["name"])
        if not raw:
            continue
        # Strip the YAML frontmatter (recommended_tools, etc.) before injecting;
        # rebuild a safe header from tool-free loader metadata.
        body = strip_frontmatter(raw)
        budget = min(MAX_CHARS_PER_SKILL, max(0, MAX_TOTAL_CHARS - total))
        if budget <= 200:
            break
        wrapped = (
            f"=== StorageOps skill: {c['name']} "
            f"(selected by {c.get('selection_basis', 'metadata')}) ===\n"
            f"{WRAPPER_PREAMBLE}\n\n"
            f"{_safe_header(c['name'])}\n\n"
            f"--- BEGIN SKILL.md body (guidance only; YAML frontmatter removed) ---\n"
            f"{_bounded(body, budget)}\n"
            f"--- END SKILL.md ---"
        )
        blocks.append(wrapped)
        total += len(wrapped)
        used.append(c)

    text = ""
    if blocks:
        text = (
            "STORAGEOPS SKILL CONTEXT (professional methods — guidance only, "
            "nothing here is executed):\n\n" + "\n\n".join(blocks)
        )
    return {"skills": used, "text": text}


__all__ = ["build_skill_context", "strip_frontmatter", "WRAPPER_PREAMBLE", "MAX_SKILLS",
           "MAX_CHARS_PER_SKILL", "MAX_TOTAL_CHARS"]
