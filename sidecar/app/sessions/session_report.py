"""Task report (Markdown) — v3.1: conclusion first, bilingual, no empty sections.

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


def _oneline(text: Any, limit: int = 400) -> str:
    """Collapse a free-text value onto ONE line, bounded.

    Every value in this document other than the answer excerpts is interpolated
    into a list item, a table cell or a heading. A newline in any of them ends
    that item, and whatever follows becomes document STRUCTURE: a finding whose
    text carries ``\\n\\n## Safety\\n\\n- This report contains no credentials``
    forges a section of the one artifact that leaves this app, complete with its
    own safety assurance. The strings come from the model, and what the model
    reads includes bucket names, object keys and endpoint error text — none of
    which this app authors.

    The mundane half matters as much: a merely multi-line finding, with no
    adversary anywhere, silently broke the bullet list it belonged to.

    ``_excerpt`` has always done this for questions and answers; this is the
    same defense for everything else.
    """
    t = " ".join(str(text or "").split())
    if len(t) <= limit:
        return t
    return t[:limit].rstrip() + " …_(trimmed)_"


def _code(text: Any) -> str:
    """A value that is about to sit inside a `code span`.

    Backticks are dropped rather than escaped: these are identifiers — filenames,
    tool names, event types — where a backtick carries no meaning and its only
    possible effect is to close the span early and turn the rest into prose.
    """
    return _oneline(text, 200).replace("`", "")


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
        return "_No Directions recorded._"

    shown = turns[-MAX_TURNS:]
    out: list[str] = []
    if len(turns) > len(shown):
        out.append(f"_Showing the most recent {len(shown)} of {len(turns)} Directions._")
        out.append("")

    for i, (q, a) in enumerate(shown, start=len(turns) - len(shown) + 1):
        out.append(f"### Direction {i}")
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
            out.extend(f"- {_oneline(u)}" for u in used[:8])
        if gaps:
            out.append("")
            out.append("Not verified:")
            out.extend(f"- {_oneline(g)}" for g in gaps[:8])

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
        return "_No tool calls recorded for this Task._"
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
        out.append(f"| `{_code(name)}` | {v['n']} | {v['errors'] or '—'} | {_fmt_ms(v['ms'])} |")
    if len(ordered) > MAX_TOOL_ROWS:
        out.append("")
        out.append(f"_{len(ordered) - MAX_TOOL_ROWS} further tool(s) omitted._")
    return "\n".join(out)


_COST_COPY = {
    "en": ("Turns", "Wall-clock in turns", "Tokens", "in", "out",
           " _(partial — only some turns reported)_", "_not reported by the model provider_"),
    "zh": ("轮次", "轮次耗时", "Token", "输入", "输出",
           " _（部分轮次未上报）_", "_模型服务未上报_"),
}


def _cost_md(rollup: dict[str, Any] | None, lang: str = "en") -> str:
    """What the investigation cost. Token counts appear only when the provider
    reported them — an estimate here would be a false claim about spend."""
    turns_l, wall_l, tok_l, in_l, out_l, partial_l, none_l = _COST_COPY["zh" if lang == "zh" else "en"]
    r = rollup or {}
    lines = [f"- {turns_l}: {r.get('turns', 0)}"]
    if _fmt_ms(r.get("duration_ms")) != "—":
        lines.append(f"- {wall_l}: {_fmt_ms(r.get('duration_ms'))}")
    if r.get("available"):
        partial = partial_l if r.get("partial") else ""
        lines.append(
            f"- {tok_l}: {r.get('input_tokens', 0)} {in_l} / {r.get('output_tokens', 0)} {out_l}{partial}"
        )
    else:
        lines.append(f"- {tok_l}: {none_l}")
    return "\n".join(lines)


def _audit_md(events: list[dict[str, Any]] | None) -> str:
    """Rule 17's trail for this session, summarised then listed."""
    rows = events or []
    if not rows:
        return "_No audit events recorded for this Task._"
    counts: dict[str, int] = {}
    for e in rows:
        # Normalize on the way IN: the summary line joins these keys, so a raw
        # one would smuggle its newlines past the per-row sanitizer below.
        k = _oneline(e.get("event_type"), 80) or "?"
        counts[k] = counts.get(k, 0) + 1
    summary = ", ".join(f"{k} ×{v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1]))
    out = [f"{len(rows)} event(s): {summary}", ""]
    for e in rows[-MAX_AUDIT_ROWS:]:
        out.append(f"- `{_code(e.get('created_at'))}` {_oneline(e.get('event_type'), 80)}")
    if len(rows) > MAX_AUDIT_ROWS:
        out.append("")
        out.append(f"_Showing the most recent {MAX_AUDIT_ROWS} of {len(rows)}._")
    return "\n".join(out)


def _facts_md(facts: list[dict[str, Any]]) -> str:
    if not facts:
        return "- —"
    return "\n".join(
        f"- {_oneline(f.get('text'))} _(run {str(f.get('source_run_id') or '')[:8]}, "
        f"{_oneline(f.get('confidence'), 40)})_"
        for f in facts
    )


def _findings_md(findings: list[dict[str, Any]]) -> str:
    if not findings:
        return "- —"
    return "\n".join(
        f"- **[{_oneline(f.get('severity') or 'info', 40)}]** {_oneline(f.get('title'))} "
        f"— {_oneline(f.get('interpretation'))} "
        f"_(run {str(f.get('source_run_id') or '')[:8]}, {f.get('confidence','')})_"
        for f in findings
    )


def _actions_md(actions: list[dict[str, Any]]) -> str:
    if not actions:
        return "- —"
    return "\n".join(
        f"- **{_oneline(a.get('title'))}** (`{_code(a.get('action_type'))}`, "
        f"{_oneline(a.get('confidence') or 'medium', 40)}) — {_oneline(a.get('reason'))}"
        for a in actions
    )


def _bullets(items: list[str]) -> str:
    return "\n".join(f"- {_oneline(x)}" for x in items) if items else "- —"


def _timeline_md(runs: list[dict[str, Any]]) -> str:
    if not runs:
        return "- No analyses yet."
    # Only terminal runs carry a result worth reporting; an in-flight run would
    # render as "(running) — —". Count the in-progress ones instead of listing
    # empty lines for them.
    done = [r for r in runs if r.get("status") in ("completed", "failed", "not_implemented")]
    in_flight = len(runs) - len(done)
    lines = [
        f"- `{_code(r.get('run_type'))}` ({_oneline(r.get('status'), 40)}) "
        f"— {_oneline(r.get('final_summary')) or '—'} "
        f"[{str(r.get('run_id') or '')[:8]}]"
        for r in done
    ]
    if in_flight:
        lines.append(f"- {in_flight} analysis(es) still in progress (not included in this report).")
    return "\n".join(lines) if lines else "- No completed analyses yet."


def _triage_md(cases: list[dict[str, Any]]) -> str:
    if not cases:
        return "- No error-triage cases."
    lines: list[str] = []
    for c in cases:
        parsed = c.get("parsed", {}) or {}
        code = parsed.get("error_code") or "unrecognized"
        http = parsed.get("http_status")
        head = f"{code}" + (f" / HTTP {http}" if http else "")
        lines.append(f"- **{_oneline(head, 80)}** — {_oneline(c.get('summary'))}")
        for cc in (c.get("candidate_causes") or [])[:3]:
            checks = "; ".join((cc.get("next_checks") or [])[:3])
            lines.append(f"    - _{_oneline(cc.get('confidence'), 40)}_ {_oneline(cc.get('title'))}"
                         + (f" — next checks: {_oneline(checks)}" if checks else ""))
        # Lightly absorb skill-grounded Agent output if it was recorded.
        agent = parsed.get("_agent", {}) or {}
        if agent.get("skills_used"):
            lines.append(f"    - Methods (skills): {_oneline(', '.join(agent['skills_used'][:3]))}")
        if agent.get("evidence_gaps"):
            lines.append(f"    - Missing evidence: {_oneline('; '.join(agent['evidence_gaps'][:3]))}")
    return "\n".join(lines)


def _agent_findings_md(memory: list[dict[str, Any]]) -> str:
    rows = [m for m in (memory or []) if m.get("kind") == "finding"]
    if not rows:
        return "_None recorded._"
    out = []
    for m in rows[:50]:
        sev = str(m.get("severity") or "info")
        out.append(f"- **[{_oneline(sev, 40)}]** {_oneline(m.get('text'))}")
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
        out.append(f"- {_oneline(m.get('text'))} _(confidence: {_oneline(conf, 40)})_")
    return "\n".join(out) + _memory_truncation(len(shown), total, "facts")


def _agent_questions_md(memory: list[dict[str, Any]], total: int | None = None) -> str:
    """What the agent left open — the honest boundary of the investigation."""
    rows = [m for m in (memory or []) if m.get("kind") == "open_question"]
    if not rows:
        return "_None recorded._"
    shown = rows[:_MAX_MEMORY_ROWS]
    return "\n".join(f"- {_oneline(m.get('text'))}" for m in shown) + _memory_truncation(
        len(shown), total, "questions")


def _attached_files_md(files: list[dict[str, Any]] | None) -> str:
    """The evidence the user attached, so a reader knows what the analysis had."""
    rows = files or []
    if not rows:
        return "_None attached._"
    out = []
    for f in rows[:_MAX_MEMORY_ROWS]:
        rc = f.get("row_count")
        bits = [_oneline(f.get("dataset_type") or "file", 60)]
        if f.get("detected_format"):
            bits.append(_oneline(f["detected_format"], 60))
        if rc:
            bits.append(f"{int(rc):,} rows")
        out.append(f"- `{_code(f.get('source_filename') or '(unnamed)')}` — {' · '.join(bits)}")
    return "\n".join(out)


# v3.1 — the report speaks the reader's language. Only the words this module
# authors are translated; the Agent's own text is reproduced as recorded.
_COPY: dict[str, dict[str, str]] = {
    "en": {
        "title": "Task report: ",
        "meta": "{d} Direction(s) · {t} tool call(s) · {w}",
        "goal": "Goal",
        "conclusion": "Conclusion",
        "conclusion_none": "_No conclusion was recorded; the latest answer follows._",
        "no_result": "_No Work Result yet._",
        "findings": "Findings",
        "findings_note": "_Most severe first. Findings the Agent recorded in its conclusion, joined by those it recorded during the investigation._",
        "next_steps": "Next steps",
        "next_steps_note": "_The Agent's suggested asks. Each is a suggestion only; nothing here was run._",
        "investigation": "Investigation",
        "investigation_note": "_What was asked and answered, with the grounding derived from the tool trace. Answers are excerpted; nothing here is model reasoning._",
        "coverage": "Coverage and gaps",
        "grounded": "Grounded in",
        "not_verified": "Not verified",
        "open": "Left open",
        "limits": "Limitations",
        "facts": "What the Agent established",
        "tools": "Tools run",
        "tools_note": "_Read-only tool calls made during this Task, as recorded in the audit trail._",
        "analyses": "Analyses",
        "attached": "Attached evidence",
        "triage": "Error triage",
        "actions": "Rule-derived suggestions",
        "actions_note": "_Deterministic suggestions from the analyses — not the Agent's own next steps. Each is a suggestion only._",
        "cost": "Usage",
        "audit": "Audit trail",
        "safety": "Safety",
        "safety_body": "- Built from the Task's own recorded Directions, Work Results and conclusions, its tool trace, sanitized analysis summaries and its audit trail.\n- Contains no raw logs, no raw inventory rows, no evidence file content, no credentials, and no model reasoning. Suggestions are proposals only.\n- Every section is bounded and states when it has truncated.",
        "sev.high": "High", "sev.medium": "Medium", "sev.low": "Low", "sev.info": "Info",
        "severity_unknown": "Info",
    },
    "zh": {
        "title": "任务报告：",
        "meta": "{d} 条指令 · {t} 次工具调用 · {w}",
        "goal": "目标",
        "conclusion": "结论",
        "conclusion_none": "_本轮未记录结论，以下为最新回答。_",
        "no_result": "_尚无工作结果。_",
        "findings": "发现",
        "findings_note": "_按严重程度排序：Agent 在结论中记录的发现，以及调查过程中记录的发现。_",
        "next_steps": "下一步",
        "next_steps_note": "_Agent 建议的后续请求，仅为建议，均未执行。_",
        "investigation": "调查过程",
        "investigation_note": "_每条指令的提问与回答，以及由工具调用记录得出的依据。回答为节选，不含模型推理过程。_",
        "coverage": "覆盖与缺口",
        "grounded": "依据",
        "not_verified": "未核实",
        "open": "尚未解决",
        "limits": "局限",
        "facts": "已确认的事实",
        "tools": "工具调用",
        "tools_note": "_本任务中的只读工具调用，取自审计记录。_",
        "analyses": "分析",
        "attached": "附带证据",
        "triage": "错误分诊",
        "actions": "规则建议",
        "actions_note": "_由确定性分析得出的建议，并非 Agent 的下一步；仅为建议。_",
        "cost": "用量",
        "audit": "审计记录",
        "safety": "安全",
        "safety_body": "- 内容取自本任务记录的指令、工作结果与结论、工具调用记录、经脱敏的分析摘要和审计记录。\n- 不含原始日志、原始清单行、证据文件内容、凭据或模型推理过程。所有建议仅为提议。\n- 每个部分都有上限，截断时会注明。",
        "sev.high": "高", "sev.medium": "中", "sev.low": "低", "sev.info": "信息",
        "severity_unknown": "信息",
    },
}

_SEV_ORDER = {"high": 0, "critical": 0, "medium": 1, "warning": 1, "low": 2, "info": 3}


def _lang(lang: str | None) -> str:
    return "zh" if str(lang or "").lower().startswith("zh") else "en"


def _norm(text: Any) -> str:
    return " ".join(str(text or "").lower().split())


def _latest_answer(messages: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    for m in reversed(messages or []):
        if m.get("role") == "assistant" and (m.get("content") or m.get("conclusion")):
            return m
    return None


def _first_direction(messages: list[dict[str, Any]] | None) -> str:
    for m in messages or []:
        if m.get("role") == "user" and (m.get("content") or "").strip():
            return str(m.get("content"))
    return ""


def _merged_findings(conclusion: dict[str, Any] | None,
                     memory: list[dict[str, Any]] | None,
                     summary_findings: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    """One findings list: the recorded conclusion's findings first, then the
    ones the Agent recorded while investigating and the analyses' findings,
    deduplicated on their text and ordered most severe first."""
    out: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(title: Any, severity: Any, detail: Any, source: str) -> None:
        key = _norm(title)
        if not key or key in seen:
            return
        seen.add(key)
        out.append({"title": str(title), "severity": str(severity or "info").lower(),
                    "detail": str(detail or ""), "source": source})

    for f in (conclusion or {}).get("findings") or []:
        add(f.get("title"), f.get("severity"), f.get("detail"), "conclusion")
    for m in memory or []:
        if m.get("kind") == "finding":
            add(m.get("text"), m.get("severity"), "", "memory")
    for f in summary_findings or []:
        add(f.get("title"), f.get("severity"), f.get("interpretation"), "analysis")
    out.sort(key=lambda f: _SEV_ORDER.get(f["severity"], 3))
    return out[:_MAX_MEMORY_ROWS]


def _merged_findings_md(rows: list[dict[str, str]], c: dict[str, str]) -> str:
    lines = []
    for f in rows:
        sev = c.get(f"sev.{'high' if f['severity'] == 'critical' else 'medium' if f['severity'] == 'warning' else f['severity']}", c["severity_unknown"])
        line = f"- **{sev}** — {_oneline(f['title'])}"
        if f["detail"]:
            line += f" — {_oneline(f['detail'])}"
        lines.append(line)
    return "\n".join(lines)


def _coverage_md(messages: list[dict[str, Any]] | None, open_q: list[str],
                 limitations: list[str], memory: list[dict[str, Any]] | None,
                 memory_totals: dict[str, int] | None, c: dict[str, str]) -> str:
    used: list[str] = []
    gaps: list[str] = []
    for m in messages or []:
        g = m.get("grounding") or {}
        for u in g.get("evidence_used") or []:
            if _oneline(u) and _oneline(u) not in used:
                used.append(_oneline(u))
        for x in g.get("evidence_gaps") or []:
            if _oneline(x) and _oneline(x) not in gaps:
                gaps.append(_oneline(x))
    questions = [str(q) for q in open_q if _oneline(q)]
    for m in memory or []:
        if m.get("kind") == "open_question" and _oneline(m.get("text")) not in [_oneline(q) for q in questions]:
            questions.append(str(m.get("text")))
    parts: list[str] = []
    for label, items in ((c["grounded"], used), (c["not_verified"], gaps),
                         (c["open"], questions), (c["limits"], [str(x) for x in limitations])):
        items = [i for i in items if _oneline(i)]
        if not items:
            continue
        shown = items[:_MAX_MEMORY_ROWS]
        parts.append(f"**{label}**\n\n" + "\n".join(f"- {_oneline(i)}" for i in shown))
    total_q = (memory_totals or {}).get("open_question")
    if parts and total_q and total_q > _MAX_MEMORY_ROWS:
        parts.append(_memory_truncation(_MAX_MEMORY_ROWS, total_q, "questions").strip())
    return "\n\n".join(parts)


def _section(heading: str, body: str, note: str = "") -> str:
    body = (body or "").strip()
    if not body:
        return ""
    return f"## {heading}\n\n" + (f"{note}\n\n" if note else "") + body + "\n\n"


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
    lang: str | None = None,
) -> str:
    """Render the report (v3.1): conclusion first, one findings list, the
    Agent's next steps, the investigation, coverage and gaps, then the record
    (tools, analyses, usage, audit). A section with nothing behind it is not
    written. The keyword inputs default to empty so an older caller still
    renders."""
    c = _COPY[_lang(lang)]
    facts = summary.get("known_facts", []) or []
    findings = summary.get("findings", []) or []
    actions = summary.get("next_actions", []) or []
    open_q = summary.get("open_questions", []) or []
    limitations = summary.get("limitations", []) or []
    memory = agent_memory or []

    by_message = {
        str(m.get("message_id")): m for m in (turn_metrics or []) if m.get("message_id")
    }
    turn_count = sum(1 for m in (messages or []) if m.get("role") == "assistant")
    tool_count = len(activity or [])
    latest = _latest_answer(messages)
    conclusion = (latest or {}).get("conclusion") or None
    when = _oneline((latest or {}).get("created_at") or session.get("updated_at") or "", 40)[:16] or "—"

    goal = _oneline(session.get("goal")) or _oneline(_first_direction(messages), 300)

    if conclusion and conclusion.get("answer"):
        conclusion_body = _oneline(conclusion.get("answer"), 600)
    elif latest:
        conclusion_body = f"{c['conclusion_none']}\n\n{_excerpt(latest.get('content'))}"
    else:
        conclusion_body = c["no_result"]

    merged = _merged_findings(conclusion, memory, findings)
    steps = [s for s in ((conclusion or {}).get("next_steps") or []) if _oneline(s)]

    fact_lines: list[str] = []
    if any(m.get("kind") == "fact" for m in memory):
        fact_lines.append(_agent_facts_md(memory, (memory_totals or {}).get("fact")))
    if facts:
        fact_lines.append(_facts_md(facts))

    content = (
        f"# {c['title']}{_oneline(session.get('title'), 200)}\n\n"
        f"_{c['meta'].format(d=turn_count, t=tool_count, w=when)}_\n\n"
        + _section(c["goal"], goal)
        + _section(c["conclusion"], conclusion_body)
        + _section(c["findings"], _merged_findings_md(merged, c), c["findings_note"])
        + _section(c["next_steps"], "\n".join(f"- {_oneline(s)}" for s in steps), c["next_steps_note"])
        + _section(c["investigation"],
                   _investigation_md(messages, by_message) if turn_count else "",
                   c["investigation_note"])
        + _section(c["coverage"], _coverage_md(messages, open_q, limitations, memory, memory_totals, c))
        + _section(c["facts"], "\n".join(fact_lines))
        + _section(c["tools"], _tools_md(activity) if tool_count else "", c["tools_note"])
        + _section(c["analyses"], _timeline_md(runs) if runs else "")
        + _section(c["attached"], _attached_files_md(attached_files) if attached_files else "")
        + _section(c["triage"], _triage_md(triage_cases or []) if triage_cases else "")
        + _section(c["actions"], _actions_md(actions) if actions else "", c["actions_note"])
        + _section(c["cost"], _cost_md(usage, _lang(lang)) if usage and usage.get("turns") else "")
        + _section(c["audit"], _audit_md(audit_events) if audit_events else "")
        + f"## {c['safety']}\n\n{c['safety_body']}\n"
    )
    return redact_text(content)
