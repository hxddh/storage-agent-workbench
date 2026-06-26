"""Session-level Markdown report (Phase 16).

Built from the deterministic, sanitized session summary + linked-run metadata.
Contains no raw logs, no raw inventory rows, no evidence file content, no
secrets, and no chain-of-thought; the whole document is redacted on render.
"""

from __future__ import annotations

from typing import Any

from ..security.redaction import redact_text


def _facts_md(facts: list[dict[str, Any]]) -> str:
    if not facts:
        return "- —"
    return "\n".join(
        f"- {f.get('text','')} _(run {str(f.get('source_run_id') or '')[:8]}, {f.get('confidence','')})_"
        for f in facts
    )


def _findings_md(findings: list[dict[str, Any]]) -> str:
    if not findings:
        return "- —"
    return "\n".join(
        f"- **[{f.get('severity','info')}]** {f.get('title','')} — {f.get('interpretation','')} "
        f"_(run {str(f.get('source_run_id') or '')[:8]}, {f.get('confidence','')})_"
        for f in findings
    )


def _actions_md(actions: list[dict[str, Any]]) -> str:
    if not actions:
        return "- —"
    return "\n".join(
        f"- **{a.get('title','')}** ({a.get('action_type','')}, {a.get('confidence','medium')}) — {a.get('reason','')}"
        for a in actions
    )


def _bullets(items: list[str]) -> str:
    return "\n".join(f"- {x}" for x in items) if items else "- —"


def _timeline_md(runs: list[dict[str, Any]]) -> str:
    if not runs:
        return "- No runs linked yet."
    return "\n".join(
        f"- `{r.get('run_type')}` ({r.get('status')}) — {r.get('final_summary') or '—'} "
        f"[{str(r.get('run_id') or '')[:8]}]"
        for r in runs
    )


def render_session_report(
    session: dict[str, Any],
    summary: dict[str, Any],
    runs: list[dict[str, Any]],
) -> str:
    facts = summary.get("known_facts", []) or []
    findings = summary.get("findings", []) or []
    actions = summary.get("next_actions", []) or []
    open_q = summary.get("open_questions", []) or []
    limitations = summary.get("limitations", []) or []

    exec_summary = (
        f"This session pursued the goal: \"{session.get('goal') or '—'}\". "
        f"{len(runs)} run(s) were linked; {len(findings)} finding(s) and {len(facts)} fact(s) were collected."
    )

    content = f"""# Session Report: {session.get('title')}

## Session goal

{session.get('goal') or '—'}

## Executive summary

{exec_summary}

## Evidence used

{_facts_md(facts)}

## Timeline of runs

{_timeline_md(runs)}

## Key findings

{_findings_md(findings)}

## Confidence / limitations

Open questions:

{_bullets(open_q)}

Limitations:

{_bullets(limitations)}

## Recommended next actions

{_actions_md(actions)}

## Appendix: linked runs

{_timeline_md(runs)}

## Safety

- This report is built from deterministic, sanitized run summaries and findings.
- It contains no raw logs, no raw inventory rows, no evidence file content, no
  credentials, and no model reasoning. Next actions are proposals only.
"""
    return redact_text(content)
