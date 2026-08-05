"""Session-level Markdown report.

The artifact you hand to someone else. Built from the deterministic, sanitized
session summary, linked-run metadata, AND — since v0.48.0 — the investigation
the conversational agent actually carried out: what was asked, what it answered,
which read-only tools it ran, what that cost, and the audit trail.

That addition closed a real hole. The report predates the v0.20 shift to an
agent-first product, so it drew only from LINKED runs, and the agent's own work
is deliberately never linked as a run card. A six-turn investigation that probed
a bucket, hit a 403 and explained the cause rendered as a page of em dashes: the
one document meant to leave the app documented none of the work.

Contains no raw logs, no raw inventory rows, no evidence file content, no
secrets, and no chain-of-thought; every input was sanitized on write and the
whole document is redacted again on render. Every section is bounded and says so
when it truncates — a report that silently omitted half an investigation would
be worse than one that admitted it covered nothing.
"""

from __future__ import annotations

from typing import Any

from ..security.redaction import redact_text

# Bounds. A report is read by a person; past these it stops being one.
MAX_TURNS = 40          # conversational turns rendered in full
ANSWER_EXCERPT = 600    # chars of each answer
MAX_TOOL_ROWS = 25      # distinct tools in the breakdown
MAX_AUDIT_ROWS = 30     # audit events listed
_MAX_MEMORY_ROWS = 50   # agent-memory items per kind, and attached files


def _excerpt(text: str | None, limit: int = ANSWER_EXCERPT) -> str:
    """Trim to a readable excerpt, marking the cut rather than hiding it."""
    t = " ".join((text or "").split())
    if len(t) <= limit:
        return t or "—"
    return t[:limit].rstrip() + " …_(trimmed)_"


def _fmt_ms(ms: Any) -> str:
    try:
        v = int(ms or 0)
    except (TypeError, ValueError):
        return "—"
    if v <= 0:
        return "—"
    if v < 1000:
        return f"{v} ms"
    if v < 60_000:
        return f"{v / 1000:.1f} s"
    return f"{v // 60_000}m {round((v % 60_000) / 1000)}s"


def _investigation_md(messages: list[dict[str, Any]] | None,
                      metrics_by_message: dict[str, dict[str, Any]] | None) -> str:
    """The conversation as an investigation record: question → answer → grounding.

    Pairs each user question with the answer that followed it. Only completed
    exchanges appear; a trailing question with no answer is not a finding.
    """
    msgs = messages or []
    by_msg = metrics_by_message or {}
    turns: list[tuple[dict[str, Any], dict[str, Any]]] = []
    pending: dict[str, Any] | None = None
    for m in msgs:
        if m.get("role") == "user":
            pending = m
        elif m.get("role") == "assistant" and pending is not None:
            turns.append((pending, m))
            pending = None

    if not turns:
        return "_No conversational turns recorded._"

    shown = turns[-MAX_TURNS:]
    out: list[str] = []
    if len(turns) > len(shown):
        out.append(f"_Showing the most recent {len(shown)} of {len(turns)} turns._")
        out.append("")

    for i, (q, a) in enumerate(shown, start=len(turns) - len(shown) + 1):
        out.append(f"### Turn {i}")
        out.append("")
        out.append(f"**Asked:** {_excerpt(q.get('content'), 300)}")
        out.append("")
        out.append(f"**Answered:** {_excerpt(a.get('content'))}")

        grounding = a.get("grounding") or {}
        used = grounding.get("evidence_used") or []
        gaps = grounding.get("evidence_gaps") or []
        if used:
            out.append("")
            out.append("Grounded in:")
            out.extend(f"- {u}" for u in used[:8])
        if gaps:
            out.append("")
            out.append("Not verified:")
            out.extend(f"- {g}" for g in gaps[:8])

        tools = [t for t in (a.get("tool_activity") or []) if t.get("status") != "started"]
        met = by_msg.get(str(a.get("id")))
        bits: list[str] = []
        if tools:
            bits.append(f"{len(tools)} tool call(s)")
        if met and met.get("duration_ms"):
            bits.append(_fmt_ms(met.get("duration_ms")))
        if met and met.get("total_tokens"):
            bits.append(f"{met['total_tokens']} tokens")
        if bits:
            out.append("")
            out.append(f"_{' · '.join(bits)}_")
        out.append("")
    return "\n".join(out).rstrip()


def _tools_md(activity: list[dict[str, Any]] | None) -> str:
    """Which read-only tools the investigation actually ran, and how they fared."""
    rows = activity or []
    if not rows:
        return "_No tool calls recorded for this session._"
    agg: dict[str, dict[str, Any]] = {}
    for r in rows:
        name = r.get("tool_name") or "?"
        cur = agg.setdefault(name, {"n": 0, "errors": 0, "ms": 0})
        cur["n"] += 1
        if r.get("status") == "error":
            cur["errors"] += 1
        try:
            cur["ms"] += int(r.get("duration_ms") or 0)
        except (TypeError, ValueError):
            pass
    ordered = sorted(agg.items(), key=lambda kv: (-kv[1]["n"], kv[0]))
    out = ["| Tool | Calls | Failed | Time |", "| --- | ---: | ---: | ---: |"]
    for name, v in ordered[:MAX_TOOL_ROWS]:
        out.append(f"| `{name}` | {v['n']} | {v['errors'] or '—'} | {_fmt_ms(v['ms'])} |")
    if len(ordered) > MAX_TOOL_ROWS:
        out.append("")
        out.append(f"_{len(ordered) - MAX_TOOL_ROWS} further tool(s) omitted._")
    return "\n".join(out)


def _cost_md(rollup: dict[str, Any] | None) -> str:
    """What the investigation cost. Token counts appear only when the provider
    reported them — an estimate here would be a false claim about spend."""
    r = rollup or {}
    lines = [
        f"- Turns: {r.get('turns', 0)}",
        f"- Wall-clock in turns: {_fmt_ms(r.get('duration_ms'))}",
    ]
    if r.get("available"):
        partial = " _(partial — only some turns reported)_" if r.get("partial") else ""
        lines.append(
            f"- Tokens: {r.get('input_tokens', 0)} in / {r.get('output_tokens', 0)} out{partial}"
        )
    else:
        lines.append("- Tokens: _not reported by the model provider_")
    return "\n".join(lines)


def _audit_md(events: list[dict[str, Any]] | None) -> str:
    """Rule 17's trail for this session, summarised then listed."""
    rows = events or []
    if not rows:
        return "_No audit events recorded for this session._"
    counts: dict[str, int] = {}
    for e in rows:
        counts[e.get("event_type") or "?"] = counts.get(e.get("event_type") or "?", 0) + 1
    summary = ", ".join(f"{k} ×{v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1]))
    out = [f"{len(rows)} event(s): {summary}", ""]
    for e in rows[-MAX_AUDIT_ROWS:]:
        out.append(f"- `{e.get('created_at','')}` {e.get('event_type','')}")
    if len(rows) > MAX_AUDIT_ROWS:
        out.append("")
        out.append(f"_Showing the most recent {MAX_AUDIT_ROWS} of {len(rows)}._")
    return "\n".join(out)


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


def _memory_truncation(rendered: int, total: int | None, noun: str) -> str:
    """State what was left out, or nothing. The count comes from the DB, not
    from the (already tail-capped) list — otherwise a session with 60 facts
    renders 50 and claims completeness."""
    if total is None or total <= rendered:
        return ""
    return f"\n\n_Truncated: {total - rendered} more {noun} recorded._"


def _agent_facts_md(memory: list[dict[str, Any]], total: int | None = None) -> str:
    """The facts the agent established and then reasoned FROM.

    Before v0.51.0 this section did not exist: of the three kinds of memory the
    agent records, the report rendered only findings, so the premises behind
    every conclusion in the document were missing from it."""
    rows = [m for m in (memory or []) if m.get("kind") == "fact"]
    if not rows:
        return "_None recorded._"
    shown = rows[:_MAX_MEMORY_ROWS]
    out = []
    for m in shown:
        conf = str(m.get("confidence") or "medium")
        out.append(f"- {m.get('text', '')} _(confidence: {conf})_")
    return "\n".join(out) + _memory_truncation(len(shown), total, "facts")


def _agent_questions_md(memory: list[dict[str, Any]], total: int | None = None) -> str:
    """What the agent left open — the honest boundary of the investigation."""
    rows = [m for m in (memory or []) if m.get("kind") == "open_question"]
    if not rows:
        return "_None recorded._"
    shown = rows[:_MAX_MEMORY_ROWS]
    return "\n".join(f"- {m.get('text', '')}" for m in shown) + _memory_truncation(
        len(shown), total, "questions")


def _attached_files_md(files: list[dict[str, Any]] | None) -> str:
    """The evidence the user attached, so a reader knows what the analysis had."""
    rows = files or []
    if not rows:
        return "_None attached._"
    out = []
    for f in rows[:_MAX_MEMORY_ROWS]:
        rc = f.get("row_count")
        bits = [str(f.get("dataset_type") or "file")]
        if f.get("detected_format"):
            bits.append(str(f["detected_format"]))
        if rc:
            bits.append(f"{int(rc):,} rows")
        out.append(f"- `{f.get('source_filename') or '(unnamed)'}` — {' · '.join(bits)}")
    return "\n".join(out)


def render_session_report(
    session: dict[str, Any],
    summary: dict[str, Any],
    runs: list[dict[str, Any]],
    triage_cases: list[dict[str, Any]] | None = None,
    agent_memory: list[dict[str, Any]] | None = None,
    *,
    messages: list[dict[str, Any]] | None = None,
    activity: list[dict[str, Any]] | None = None,
    usage: dict[str, Any] | None = None,
    turn_metrics: list[dict[str, Any]] | None = None,
    audit_events: list[dict[str, Any]] | None = None,
    attached_files: list[dict[str, Any]] | None = None,
    memory_totals: dict[str, int] | None = None,
) -> str:
    """Render the report. The keyword inputs are the investigation itself; they
    default to empty so an older caller still produces the historical document
    rather than raising."""
    facts = summary.get("known_facts", []) or []
    findings = summary.get("findings", []) or []
    actions = summary.get("next_actions", []) or []
    open_q = summary.get("open_questions", []) or []
    limitations = summary.get("limitations", []) or []

    by_message = {
        str(m.get("message_id")): m for m in (turn_metrics or []) if m.get("message_id")
    }
    turn_count = sum(1 for m in (messages or []) if m.get("role") == "assistant")
    tool_count = len(activity or [])
    # The summary now counts the work that actually happened. Before v0.48.0 it
    # counted only linked runs, which for an agent-driven session is always zero.
    exec_summary = (
        f"This session pursued the goal: \"{session.get('goal') or '—'}\". "
        f"{turn_count} conversational turn(s) ran {tool_count} read-only tool call(s); "
        f"{len(runs)} run(s) were linked; {len(findings)} finding(s) and "
        f"{len(facts)} fact(s) were collected."
    )

    content = f"""# Session Report: {session.get('title')}

## Session goal

{session.get('goal') or '—'}

## Executive summary

{exec_summary}

## Investigation

_What was asked and answered, with the grounding the agent claimed for each
answer. Answers are excerpted; nothing here is model reasoning._

{_investigation_md(messages, by_message)}

## Tools run

_Read-only tool calls made during this session, as recorded in the audit trail._

{_tools_md(activity)}

## Cost

{_cost_md(usage)}

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

## What the agent established

_The facts the agent recorded and then reasoned FROM — the premises behind every
conclusion above. Replayed into each later turn, so they steer the whole
investigation._

{_agent_facts_md(agent_memory or [], (memory_totals or {}).get("fact"))}

## What the agent left open

{_agent_questions_md(agent_memory or [], (memory_totals or {}).get("open_question"))}

## Attached evidence

{_attached_files_md(attached_files)}

## Error triage

{_triage_md(triage_cases or [])}

## Audit trail

_Rule 17: every tool call, approval, import and report generation is recorded._

{_audit_md(audit_events)}

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

- This report is built from deterministic, sanitized run summaries, findings, and
  the session's own recorded conversation, tool trace and audit trail.
- It contains no raw logs, no raw inventory rows, no evidence file content, no
  credentials, and no model reasoning. Next actions are proposals only.
- Every section is bounded and states when it has truncated.
"""
    return redact_text(content)
