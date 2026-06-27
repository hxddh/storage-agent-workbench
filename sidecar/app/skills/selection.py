"""Lightweight StorageOps skill candidate selector (Phase 19).

Picks at most 1–3 candidate skills by simple lexical overlap between the input
context (session goal + summary + user question + plain-text error signals) and
each skill's registry metadata (name / description / trigger_keywords / domains).

It is NOT a diagnostic engine: it emits ONLY `name` / `match_reason` /
`selection_basis`. It never returns a diagnosis, root cause, remediation,
confidence, score, or next-check hint, and it contains no hard-coded
error-code → skill mapping. Matching is driven entirely by registry metadata.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from . import loader

MAX_CANDIDATES = 3
_WORD = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class SkillCandidate:
    name: str
    match_reason: str
    selection_basis: str  # "keyword_match" | "domain_match" | "auto_route_fallback"


def _tokens(text: str) -> set[str]:
    return set(_WORD.findall((text or "").lower()))


def select(context_text: str) -> list[SkillCandidate]:
    """Return up to MAX_CANDIDATES candidate skills from registry metadata only."""
    skills = loader.load_registry()
    if not skills:
        return []

    blob = (context_text or "").lower()
    tokens = _tokens(context_text)

    scored: list[tuple[int, list[str], list[str], loader.SkillMeta]] = []
    for m in skills:
        kw_hits = [k for k in m.trigger_keywords if k.lower() in blob]
        domain_hits = [d for d in m.domains if d.lower() in tokens or d.lower() in blob]
        name_hit = any(t in tokens for t in _tokens(m.name))
        score = 2 * len(kw_hits) + len(domain_hits) + (1 if name_hit else 0)
        if score > 0:
            scored.append((score, kw_hits, domain_hits, m))

    if not scored:
        # No lexical match — fall back to the registry's auto_route skill (a
        # metadata property), NOT a hard-coded error mapping. None if absent.
        fallback = sorted(
            (m for m in skills if m.auto_route), key=lambda m: m.priority)
        if fallback:
            m = fallback[0]
            return [SkillCandidate(name=m.name,
                                   match_reason="general first-contact triage",
                                   selection_basis="auto_route_fallback")]
        return []

    # Higher score first; break ties by lower registry priority (more central).
    scored.sort(key=lambda t: (-t[0], t[3].priority, t[3].name))
    out: list[SkillCandidate] = []
    for _score, kw_hits, domain_hits, m in scored[:MAX_CANDIDATES]:
        reasons: list[str] = []
        if kw_hits:
            reasons.append("keywords: " + ", ".join(kw_hits[:6]))
        if domain_hits:
            reasons.append("domains: " + ", ".join(domain_hits[:4]))
        basis = "keyword_match" if kw_hits else "domain_match"
        out.append(SkillCandidate(name=m.name,
                                   match_reason="; ".join(reasons) or "metadata match",
                                   selection_basis=basis))
    return out


def candidate_dicts(context_text: str) -> list[dict[str, Any]]:
    return [{"name": c.name, "match_reason": c.match_reason, "selection_basis": c.selection_basis}
            for c in select(context_text)]


__all__ = ["SkillCandidate", "select", "candidate_dicts", "MAX_CANDIDATES"]
