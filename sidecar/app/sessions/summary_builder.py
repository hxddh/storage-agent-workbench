"""Deterministic, sanitized session summary builder (Phase 16).

Reads ONLY already-sanitized run artifacts (run_type/status/final_summary,
sanitized tool_call outputs, the persisted account profile) and produces a
bounded session context: known facts, evidence-driven findings (each referencing
a source_run_id), open questions, suggested next actions (proposals only), and
limitations. It never reads raw logs, raw inventory rows, evidence file
contents, credentials, or chain-of-thought, and never calls an LLM.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from ..repositories import account_discovery as account_repo
from ..repositories import sessions as sessions_repo
from ..security.redaction import redact_text

MAX_FACTS = 50
MAX_FINDINGS = 50
MAX_FINDINGS_PER_RUN = 20

_ANALYSIS_TYPES = {"inventory_analysis", "access_log_analysis"}


def _confidence_for(severity: str | None) -> str:
    s = (severity or "").lower()
    if s in ("critical", "warning", "error"):
        return "high"
    if s in ("opportunity", "info"):
        return "medium"
    if s == "good":
        return "low"
    return "medium"


def _collect_findings(conn: sqlite3.Connection, run_id: str) -> list[dict[str, Any]]:
    """Pull findings out of a run's sanitized tool_call outputs (e.g. config review)."""
    out: list[dict[str, Any]] = []
    rows = conn.execute(
        "SELECT tool_name, output_json_sanitized FROM tool_calls WHERE run_id = ? ORDER BY rowid",
        (run_id,),
    ).fetchall()
    for tc in rows:
        try:
            data = json.loads(tc["output_json_sanitized"] or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        for f in (data.get("findings") or [])[:MAX_FINDINGS_PER_RUN]:
            if not isinstance(f, dict):
                continue
            sev = f.get("severity") or f.get("category")
            out.append({
                "source_run_id": run_id,
                "category": f.get("category") or f.get("severity") or "info",
                "severity": str(sev or "info"),
                "confidence": _confidence_for(sev),
                "kind": "fact",
                "title": redact_text(str(f.get("title", "")))[:300],
                "interpretation": redact_text(str(f.get("detail", "")))[:600],
                "evidence": {"tool": tc["tool_name"]},
            })
    return out


def _account_facts(conn: sqlite3.Connection, run_id: str) -> tuple[list[dict], list[dict]]:
    """Return (facts, evidence_refs) derived from a persisted account profile."""
    profile = account_repo.get_profile(conn, run_id)
    if profile is None:
        return [], []
    s = profile.get("summary", {}) or {}
    facts = [{
        "text": f"Account discovery: {profile.get('visible_count', 0)} bucket(s) visible, "
                f"{profile.get('processed_count', 0)} processed.",
        "source_run_id": run_id, "kind": "fact", "confidence": "high",
    }]
    inv = s.get("buckets_with_inventory_evidence") or []
    log = s.get("buckets_with_logging_evidence") or []
    if inv:
        facts.append({"text": f"{len(inv)} bucket(s) have inventory evidence importable into inventory_analysis.",
                      "source_run_id": run_id, "kind": "fact", "confidence": "high"})
    if log:
        facts.append({"text": f"{len(log)} bucket(s) have access-log evidence importable into access_log_analysis.",
                      "source_run_id": run_id, "kind": "fact", "confidence": "high"})
    refs = [{"source_type": "account_snapshot", "source_id": profile.get("run_id"),
             "source_run_id": run_id, "summary": {"visible": profile.get("visible_count", 0)}}]
    return facts, refs


def _gaps(have_types: set[str], runs: list[dict[str, Any]]) -> tuple[list[str], list[dict[str, Any]]]:
    """Derive open questions + next-action PROPOSALS from coverage gaps."""
    open_q: list[str] = []
    actions: list[dict[str, Any]] = []
    run_id_by_type = {r["run_type"]: r["run_id"] for r in runs if r["status"] == "completed"}

    if not have_types:
        open_q.append("No completed runs yet — what is the suspected problem and which bucket is affected?")
        actions.append({"title": "Run account discovery", "action_type": "run_account_discovery",
                        "reason": "Build the account-level asset picture to anchor the investigation.",
                        "confidence": "medium", "requires_confirmation": True, "source_run_ids": []})
        return open_q, actions

    if "account_discovery" not in have_types:
        actions.append({"title": "Run account discovery", "action_type": "run_account_discovery",
                        "reason": "No account-level picture yet.", "confidence": "medium",
                        "requires_confirmation": True, "source_run_ids": []})

    has_inventory = "inventory_analysis" in have_types
    has_logs = "access_log_analysis" in have_types

    if has_inventory and not has_logs:
        open_q.append("Inventory is analyzed but access-pattern evidence is missing — is this a client-side or "
                      "storage-side problem?")
        actions.append({
            "title": "Import recent access logs",
            "action_type": "plan_access_log_import",
            "reason": "Inventory shows storage layout, but request/latency patterns need access logs.",
            "confidence": "medium", "requires_confirmation": True,
            "source_run_ids": [run_id_by_type.get("inventory_analysis")] if run_id_by_type.get("inventory_analysis") else [],
        })
    if has_logs and not has_inventory:
        open_q.append("Access logs are analyzed but capacity/layout evidence is missing.")
        actions.append({"title": "Import inventory", "action_type": "plan_inventory_import",
                        "reason": "Access patterns are known, but object size/age/layout needs inventory.",
                        "confidence": "medium", "requires_confirmation": True,
                        "source_run_ids": [run_id_by_type.get("access_log_analysis")] if run_id_by_type.get("access_log_analysis") else []})
    if "account_discovery" in have_types and not (has_inventory or has_logs):
        actions.append({"title": "Import an evidence source", "action_type": "plan_inventory_import",
                        "reason": "Buckets were discovered; import inventory or logs to analyze them.",
                        "confidence": "medium", "requires_confirmation": True,
                        "source_run_ids": [run_id_by_type.get("account_discovery")] if run_id_by_type.get("account_discovery") else []})
    if "bucket_config_review" not in have_types and "account_discovery" in have_types:
        actions.append({"title": "Review bucket configuration", "action_type": "run_bucket_config_review",
                        "reason": "Assess security/lifecycle/observability posture of a key bucket.",
                        "confidence": "low", "requires_confirmation": True, "source_run_ids": []})
    if have_types:
        actions.append({"title": "Generate a session report", "action_type": "generate_session_report",
                        "reason": "Summarize evidence and findings collected so far.",
                        "confidence": "medium", "requires_confirmation": True, "source_run_ids": []})
    return open_q, actions


def _render_md(session: dict[str, Any], facts, findings, open_q, actions, limitations) -> str:
    def bullets(items, key=None):
        if not items:
            return "- —"
        out = []
        for it in items:
            text = it if isinstance(it, str) else (it.get(key) if key else str(it))
            out.append(f"- {text}")
        return "\n".join(out)

    fact_lines = "\n".join(f"- {f['text']} _(run {f['source_run_id'][:8]}, {f['confidence']})_" for f in facts) or "- —"
    finding_lines = "\n".join(
        f"- **[{f['severity']}]** {f['title']} — {f['interpretation']} _(run {str(f.get('source_run_id') or '')[:8]}, {f['confidence']})_"
        for f in findings) or "- —"
    action_lines = "\n".join(
        f"- **{a['title']}** ({a['action_type']}, {a.get('confidence','medium')}) — {a.get('reason','')}"
        for a in actions) or "- —"
    return f"""# Session: {session.get('title')}

**Goal:** {session.get('goal') or '—'}

## Known facts

{fact_lines}

## Key findings

{finding_lines}

## Open questions

{bullets(open_q)}

## Suggested next actions (proposals only — never auto-executed)

{action_lines}

## Limitations

{bullets(limitations)}
"""


def build(conn: sqlite3.Connection, session_id: str) -> dict[str, Any]:
    """Build the deterministic summary dict (does not persist)."""
    srow = sessions_repo.get_row(conn, session_id)
    session = dict(srow) if srow else {"title": "", "goal": ""}
    runs = sessions_repo.list_runs(conn, session_id)

    facts: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    evidence_refs: list[dict[str, Any]] = []
    have_types: set[str] = set()

    for r in runs:
        if r["status"] == "completed":
            have_types.add(r["run_type"])
        if r.get("final_summary"):
            facts.append({"text": redact_text(str(r["final_summary"]))[:400], "source_run_id": r["run_id"],
                          "kind": "fact", "confidence": "high", "run_type": r["run_type"]})
        evidence_refs.append({"source_type": "run_output", "source_run_id": r["run_id"],
                              "summary": {"run_type": r["run_type"], "status": r["status"]}})
        findings.extend(_collect_findings(conn, r["run_id"]))
        if r["run_type"] == "account_discovery":
            af, ar = _account_facts(conn, r["run_id"])
            facts.extend(af)
            evidence_refs.extend(ar)

    facts = facts[:MAX_FACTS]
    findings = findings[:MAX_FINDINGS]
    open_q, raw_actions = _gaps(have_types, runs)
    # Normalize to the canonical, sanitized proposal shape (drops anything not
    # on the action_type allowlist; forces requires_confirmation).
    from . import next_actions
    actions = [p for a in raw_actions if (p := next_actions.normalize_proposal(a))]
    limitations = [
        "Summary is deterministic and derived only from sanitized run artifacts (no raw logs/rows, no secrets).",
        "Findings reflect threshold/rule-based analysis, not the full dataset.",
        "Next actions are proposals; nothing runs without explicit user action.",
    ]
    summary_md = _render_md(session, facts, findings, open_q, actions, limitations)
    return {
        "summary_md": summary_md,
        "known_facts": facts,
        "findings": findings,
        "open_questions": open_q,
        "next_actions": actions,
        "limitations": limitations,
        "evidence_refs": evidence_refs,
    }


def refresh(conn: sqlite3.Connection, session_id: str) -> dict[str, Any]:
    """Rebuild and persist the session summary, findings, and evidence refs."""
    summary = build(conn, session_id)
    sessions_repo.replace_findings(conn, session_id, summary["findings"])
    sessions_repo.replace_evidence_refs(conn, session_id, summary["evidence_refs"])
    sessions_repo.upsert_summary(conn, session_id, summary)
    return summary
