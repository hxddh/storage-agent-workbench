"""Session-level Markdown report.

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
    # Only terminal runs carry a result worth reporting; an in-flight run would
    # render as "(running) — —". Count the in-progress ones instead of listing
    # empty lines for them.
    done = [r for r in runs if r.get("status") in ("completed", "failed", "not_implemented")]
    in_flight = len(runs) - len(done)
    lines = [
        f"- `{r.get('run_type')}` ({r.get('status')}) — {r.get('final_summary') or '—'} "
        f"[{str(r.get('run_id') or '')[:8]}]"
        for r in done
    ]
    if in_flight:
        lines.append(f"- {in_flight} run(s) still in progress (not included in this report).")
    return "\n".join(lines) if lines else "- No completed runs yet."


def _triage_md(cases: list[dict[str, Any]]) -> str:
    if not cases:
        return "- No error-triage cases."
    lines: list[str] = []
    for c in cases:
        parsed = c.get("parsed", {}) or {}
        code = parsed.get("error_code") or "unrecognized"
        http = parsed.get("http_status")
        head = f"{code}" + (f" / HTTP {http}" if http else "")
        lines.append(f"- **{head}** — {c.get('summary', '')}")
        for cc in (c.get("candidate_causes") or [])[:3]:
            checks = "; ".join((cc.get("next_checks") or [])[:3])
            lines.append(f"    - _{cc.get('confidence')}_ {cc.get('title')}"
                         + (f" — next checks: {checks}" if checks else ""))
        # Lightly absorb skill-grounded Agent output if it was recorded.
        agent = parsed.get("_agent", {}) or {}
        if agent.get("skills_used"):
            lines.append(f"    - Methods (skills): {', '.join(agent['skills_used'][:3])}")
        if agent.get("evidence_gaps"):
            lines.append(f"    - Missing evidence: {'; '.join(agent['evidence_gaps'][:3])}")
    return "\n".join(lines)


def _agent_findings_md(memory: list[dict[str, Any]]) -> str:
    rows = [m for m in (memory or []) if m.get("kind") == "finding"]
    if not rows:
        return "_None recorded._"
    out = []
    for m in rows[:50]:
        sev = str(m.get("severity") or "info")
        out.append(f"- **[{sev}]** {m.get('text', '')}")
    return "\n".join(out)


def render_session_report(
    session: dict[str, Any],
    summary: dict[str, Any],
    runs: list[dict[str, Any]],
    triage_cases: list[dict[str, Any]] | None = None,
    agent_memory: list[dict[str, Any]] | None = None,
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

## Agent-recorded findings

_Findings the conversational agent explicitly recorded during its investigation
(provenance: agent-recorded, grounded in read-only tool output). Critical facts
like "bucket X became public since the last survey" live here — previously they
existed only in chat prose and never reached this report._

{_agent_findings_md(agent_memory or [])}

## Error triage

{_triage_md(triage_cases or [])}

## Confidence / limitations

Open questions:

{_bullets(open_q)}

Limitations:

{_bullets(limitations)}

## Recommended next actions

_Deterministic, rule-derived suggestions from the linked runs — not the agent's
own proposals (those appear in the conversation). Each is a suggestion only._

{_actions_md(actions)}

## Appendix: linked runs

{_timeline_md(runs)}

## Safety

- This report is built from deterministic, sanitized run summaries and findings.
- It contains no raw logs, no raw inventory rows, no evidence file content, no
  credentials, and no model reasoning. Next actions are proposals only.
"""
    return redact_text(content)
