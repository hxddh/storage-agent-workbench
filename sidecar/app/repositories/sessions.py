"""Session repository.

A Session is a persistent working context linking runs, evidence references,
findings, a deterministic summary, and a lightweight message thread. NOT a
project-management/kanban/ticketing system. Every JSON / content value is
redaction-passed before storage — never AK/SK/session token/Authorization/
cookies/presigned URL/model key, never raw logs / raw inventory rows /
chain-of-thought.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import uuid
from pathlib import Path
from typing import Any

from ..models.schemas import SessionCreate, SessionUpdate
from ..security.redaction import redact, redact_text
from . import utcnow

# Map a run_type to its session role.
RUN_ROLE = {
    "account_discovery": "account_discovery",
    "inventory_analysis": "analysis",
    "access_log_analysis": "analysis",
    "bucket_config_review": "config_review",
    "diagnostic": "diagnostic",
}


def _dumps(value: Any) -> str:
    return json.dumps(redact(value), default=str)


def _touch(conn: sqlite3.Connection, session_id: str) -> None:
    conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (utcnow(), session_id))


# --- sessions ---------------------------------------------------------------


def create(conn: sqlite3.Connection, data: SessionCreate) -> str:
    session_id = uuid.uuid4().hex
    now = utcnow()
    conn.execute(
        "INSERT INTO sessions (id, title, goal, provider_id, primary_bucket, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
        (session_id, redact_text(data.title), redact_text(data.goal or "") or None,
         data.provider_id, redact_text(data.primary_bucket or "") or None, now, now),
    )
    conn.commit()
    return session_id


def update(conn: sqlite3.Connection, session_id: str, data: SessionUpdate) -> None:
    sets, params = [], []
    if data.title is not None:
        # A user rename wins forever over the runtime's title step (v1.10.0).
        sets.append("title = ?"); params.append(redact_text(data.title))
        sets.append("title_source = 'user'")
    if data.goal is not None:
        sets.append("goal = ?"); params.append(redact_text(data.goal))
    if data.provider_id is not None:
        sets.append("provider_id = ?"); params.append(data.provider_id)
    if data.primary_bucket is not None:
        sets.append("primary_bucket = ?"); params.append(redact_text(data.primary_bucket))
    if data.status is not None:
        sets.append("status = ?"); params.append(data.status)
    if data.pinned is not None:
        sets.append("pinned = ?"); params.append(1 if data.pinned else 0)
    if not sets:
        return
    sets.append("updated_at = ?"); params.append(utcnow())
    params.append(session_id)
    conn.execute(f"UPDATE sessions SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()


def delete(conn: sqlite3.Connection, session_id: str) -> list[str]:
    """Delete a session and all its child rows (thread, runs links, findings,
    evidence refs, summary, agent memory, datasets, triage cases, turn metrics,
    tool calls), plus the INTERNAL ('agent'-origin) runs it spawned —
    surveys/config-reviews that exist only to serve this investigation. Returns
    the ids of those deleted runs so the caller can remove their on-disk
    ``data/runs/{id}/`` trees. User-authored report runs are left intact.

    Every child row is deleted EXPLICITLY as well as by FK cascade, so the
    behaviour is identical if ``PRAGMA foreign_keys`` is ever off. That claim was
    made here before and was not true (v0.60.0): four cascading tables —
    ``error_triage_cases``, ``session_agent_memory``, ``session_datasets``,
    ``turn_metrics`` — had no explicit delete, so the stated safety property held
    only while the pragma did.

    ``tool_calls`` is the sharper case: its only foreign key is ``run_id ->
    runs``, so a conversational tool call (``run_id IS NULL``) had NO cascade and
    no explicit delete either. Those rows survived the session forever — and
    ``data_maintenance.prune_audit_logs`` deliberately skips any row with a
    ``session_id``, on the stated grounds that it is "reachable through its
    session (cascade-equivalent: the session's own delete path)". It was not.
    A deleted investigation left its sanitized tool inputs and outputs — bucket
    names, object-key prefixes — in the database permanently. The explicit delete
    below is what makes that comment true.

    ``audit_logs`` is deliberately NOT deleted here. It is an append-only
    security trail bounded by its own retention window (rule 17), not user
    content that a session owns."""
    from . import runs as runs_repo

    agent_run_ids = runs_repo.agent_run_ids_for_session(conn, session_id)
    for rid in agent_run_ids:
        conn.execute("DELETE FROM runs WHERE id = ?", (rid,))
    for tbl in ("session_messages", "session_runs", "session_findings",
                "session_evidence_refs", "session_summaries",
                # v0.60.0 — these cascade, but the docstring above promises an
                # explicit delete too, and that promise was previously false.
                "session_agent_memory", "session_datasets",
                "error_triage_cases", "turn_metrics",
                # v0.60.0 — this one does NOT cascade on session_id at all.
                "tool_calls"):
        conn.execute(f"DELETE FROM {tbl} WHERE session_id = ?", (session_id,))
    # v0.94.0 — durable task-runtime rows. agent_tasks (and its FK children)
    # cascade from sessions, but the explicit deletes keep the pragma-off
    # promise above; execution_events carries NO foreign key at all (append-only
    # log), so its delete here is the only one it gets.
    for tbl in ("task_executions", "execution_events", "task_decisions",
                "work_results", "task_artifacts", "task_context_versions"):
        conn.execute(f"DELETE FROM {tbl} WHERE task_id = ?", (session_id,))
    conn.execute("DELETE FROM agent_tasks WHERE id = ?", (session_id,))
    conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    conn.commit()
    return agent_run_ids


def fork(conn: sqlite3.Connection, session_id: str,
         up_to_message_id: str | None = None) -> str | None:
    """Create a new session that copies another's title/goal/provider, its
    message thread, the agent's working memory, its uploaded datasets, and its
    run LINKS (read-only references to the shared run records — needed so
    run-dependent proposal cards stay actionable in the fork). Deterministic
    findings and the derived summary are NOT copied (they are rebuilt from the
    linked runs on demand).

    ``up_to_message_id`` branches from a POINT IN the thread instead of copying
    all of it (v0.61.0). An investigation that took a wrong turn at exchange 30
    could only be duplicated whole and then manually unwound; this keeps
    everything through that message and drops what came after, so the user can
    ask the other question from there and keep both threads.

    The message cut uses ``rowid``, which is exact. The other three copies —
    memory, datasets, run links — have only ``created_at`` to filter on, so a row
    written in the SAME SECOND as the branch message is included rather than
    dropped: erring toward carrying a fact the agent had established is the
    recoverable direction, and it is stated here rather than left as a surprise.

    An unknown ``up_to_message_id``, or one belonging to another session, returns
    None rather than silently forking the whole thread — a branch point the
    caller cannot see is worse than a refusal."""
    src = get_row(conn, session_id)
    if src is None:
        return None
    cut_rowid: int | None = None
    cut_created: str | None = None
    if up_to_message_id is not None:
        row = conn.execute(
            "SELECT rowid, created_at FROM session_messages WHERE id = ? AND session_id = ?",
            (up_to_message_id, session_id)).fetchone()
        if row is None:
            return None
        cut_rowid, cut_created = row["rowid"], row["created_at"]
    new_id = uuid.uuid4().hex
    now = utcnow()
    suffix = " (branch)" if up_to_message_id is not None else " (fork)"
    title = (src["title"] or "Untitled")[:160] + suffix
    conn.execute(
        "INSERT INTO sessions (id, title, goal, provider_id, primary_bucket, status, pinned, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)",
        (new_id, title, src["goal"], src["provider_id"], src["primary_bucket"], now, now),
    )
    msgs = conn.execute(
        "SELECT role, content, referenced_run_ids, referenced_evidence_ids, tool_activity, "
        "grounding, proposed_actions, created_at "
        "FROM session_messages WHERE session_id = ? AND (? IS NULL OR rowid <= ?) "
        "ORDER BY rowid", (session_id, cut_rowid, cut_rowid)
    ).fetchall()
    for m in msgs:
        keys = m.keys()
        # grounding / proposed_actions are stored as JSON strings (migration 16);
        # copy them verbatim so a forked thread keeps its grounding + next-action
        # cards, matching the docstring's "copies its full message thread".
        conn.execute(
            "INSERT INTO session_messages "
            "(id, session_id, role, content, referenced_run_ids, referenced_evidence_ids, tool_activity, "
            "grounding, proposed_actions, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, new_id, m["role"], m["content"],
             m["referenced_run_ids"], m["referenced_evidence_ids"],
             (m["tool_activity"] if "tool_activity" in keys else None),
             (m["grounding"] if "grounding" in keys else None),
             (m["proposed_actions"] if "proposed_actions" in keys else None),
             m["created_at"]),
        )
    # Copy the agent's working memory so a fork doesn't lose what the agent learned.
    mem = conn.execute(
        "SELECT kind, text, severity, confidence, source_run_id, status, created_at "
        "FROM session_agent_memory WHERE session_id = ? AND status = 'active' "
        "AND (? IS NULL OR created_at <= ?) ORDER BY rowid",
        (session_id, cut_created, cut_created),
    ).fetchall()
    for r in mem:
        conn.execute(
            "INSERT INTO session_agent_memory "
            "(id, session_id, kind, text, severity, confidence, source_run_id, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, new_id, r["kind"], r["text"], r["severity"],
             r["confidence"], r["source_run_id"], r["status"], r["created_at"]),
        )
    # Copy uploaded datasets (rows + the raw files on disk) so a forked
    # conversation keeps the files the agent analyzed. The copied file lands in
    # the new session's raw dir and the row points at it; analysis re-derives the
    # DuckDB table on demand, so duckdb_path/table_name reset to 'uploaded'.
    from .. import config
    ds_rows = conn.execute(
        "SELECT dataset_type, source_filename, stored_path, detected_format "
        "FROM session_datasets WHERE session_id = ? AND (? IS NULL OR created_at <= ?) "
        "ORDER BY rowid", (session_id, cut_created, cut_created)
    ).fetchall()
    for d in ds_rows:
        new_stored_rel = d["stored_path"]
        if d["stored_path"]:
            src_abs = config.data_dir() / d["stored_path"]
            if src_abs.exists():
                dest_dir = config.data_dir() / "sessions" / new_id / "raw"
                dest_dir.mkdir(parents=True, exist_ok=True)
                dest_abs = dest_dir / Path(d["stored_path"]).name
                shutil.copy2(src_abs, dest_abs)
                new_stored_rel = config.rel_path(dest_abs)
        conn.execute(
            "INSERT INTO session_datasets "
            "(id, session_id, dataset_type, source_filename, stored_path, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, 'uploaded', ?)",
            (uuid.uuid4().hex, new_id, d["dataset_type"], d["source_filename"],
             new_stored_rel, now),
        )
    # Copy run LINKS (read-only references — the run records themselves are
    # shared, not duplicated). Without them, a copied proposal card that resolves
    # against the session's runs (e.g. "import inventory" needing the
    # account_discovery run) dead-ends in the fork with "run discovery first".
    run_links = conn.execute(
        "SELECT run_id, role, created_at FROM session_runs "
        "WHERE session_id = ? AND (? IS NULL OR created_at <= ?) ORDER BY rowid",
        (session_id, cut_created, cut_created)
    ).fetchall()
    for rl in run_links:
        conn.execute(
            "INSERT INTO session_runs (id, session_id, run_id, role, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, new_id, rl["run_id"], rl["role"], rl["created_at"]),
        )
    conn.commit()
    return new_id


def get_row(conn: sqlite3.Connection, session_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()


def _enrich(conn: sqlite3.Connection, rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    # Two grouped aggregates keyed by session, instead of 2 COUNT queries per row
    # (an N+1 that made every rail load scale with the session count).
    ids = [r["id"] for r in rows]
    if not ids:
        return []
    ph = ",".join("?" * len(ids))
    run_counts = {row[0]: row[1] for row in conn.execute(
        f"SELECT session_id, count(*) FROM session_runs "
        f"WHERE session_id IN ({ph}) GROUP BY session_id", ids)}
    finding_counts = {row[0]: row[1] for row in conn.execute(
        f"SELECT session_id, count(*) FROM session_findings "
        f"WHERE status = 'active' AND session_id IN ({ph}) GROUP BY session_id", ids)}
    out = []
    for r in rows:
        d = dict(r)
        d["run_count"] = run_counts.get(r["id"], 0)
        d["finding_count"] = finding_counts.get(r["id"], 0)
        out.append(d)
    return out


def list_all(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC, rowid DESC"
    ).fetchall()
    return _enrich(conn, rows)


def search(conn: sqlite3.Connection, query: str | None) -> list[dict[str, Any]]:
    """Sessions whose title OR any message content matches `query` (substring,
    case-insensitive). Empty query returns the full list."""
    q = (query or "").strip()
    if not q:
        return list_all(conn)
    # Escape LIKE wildcards so a literal % or _ in the query isn't treated as one.
    esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    like = f"%{esc}%"
    # Bounded: the message-content EXISTS clause is an unindexable scan fired per
    # (debounced) keystroke; a LIMIT keeps its worst case flat as the thread grows.
    rows = conn.execute(
        "SELECT s.* FROM sessions s "
        "WHERE s.title LIKE ? ESCAPE '\\' "
        "   OR EXISTS (SELECT 1 FROM session_messages m "
        "              WHERE m.session_id = s.id AND m.content LIKE ? ESCAPE '\\') "
        "ORDER BY s.pinned DESC, s.updated_at DESC, s.rowid DESC "
        "LIMIT 50",
        (like, like),
    ).fetchall()
    return _enrich(conn, rows)


def session_id_for_run(conn: sqlite3.Connection, run_id: str) -> str | None:
    """The session a run is linked to, if any.

    A run started outside a session has none, which is a real answer — the audit
    row stays run-scoped rather than being attributed to an arbitrary session.
    """
    row = conn.execute(
        "SELECT session_id FROM session_runs WHERE run_id = ? LIMIT 1", (run_id,)
    ).fetchone()
    return row[0] if row else None


def title_for(conn: sqlite3.Connection, session_id: str | None) -> str | None:
    if not session_id:
        return None
    row = conn.execute("SELECT title FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return row["title"] if row else None


# --- session_runs -----------------------------------------------------------


def link_run(conn: sqlite3.Connection, session_id: str, run_id: str, role: str | None) -> None:
    existing = conn.execute(
        "SELECT 1 FROM session_runs WHERE session_id = ? AND run_id = ?", (session_id, run_id)
    ).fetchone()
    if existing:
        return
    conn.execute(
        "INSERT INTO session_runs (id, session_id, run_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
        (uuid.uuid4().hex, session_id, run_id, role, utcnow()),
    )
    _touch(conn, session_id)
    conn.commit()


def list_runs(conn: sqlite3.Connection, session_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT sr.run_id, sr.role, sr.created_at AS linked_at, "
        "       r.run_type, r.status, r.title, r.final_summary, r.origin "
        "FROM session_runs sr JOIN runs r ON r.id = sr.run_id "
        "WHERE sr.session_id = ? ORDER BY sr.rowid",
        (session_id,),
    ).fetchall()
    return [
        {
            "run_id": r["run_id"], "role": r["role"], "run_type": r["run_type"],
            "status": r["status"], "title": r["title"], "final_summary": r["final_summary"],
            "origin": r["origin"], "created_at": r["linked_at"],
        }
        for r in rows
    ]


# --- evidence refs (rebuilt on each summary refresh) ------------------------


def replace_evidence_refs(conn: sqlite3.Connection, session_id: str, refs: list[dict[str, Any]]) -> None:
    conn.execute("DELETE FROM session_evidence_refs WHERE session_id = ?", (session_id,))
    for ref in refs:
        conn.execute(
            "INSERT INTO session_evidence_refs "
            "(id, session_id, source_type, source_id, source_run_id, summary_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, session_id, ref.get("source_type"), ref.get("source_id"),
             ref.get("source_run_id"), _dumps(ref.get("summary", {})), utcnow()),
        )
    conn.commit()


# --- findings (rebuilt on each summary refresh) -----------------------------


def replace_findings(conn: sqlite3.Connection, session_id: str, findings: list[dict[str, Any]]) -> None:
    conn.execute("DELETE FROM session_findings WHERE session_id = ?", (session_id,))
    for f in findings:
        conn.execute(
            "INSERT INTO session_findings "
            "(id, session_id, source_run_id, category, severity, confidence, kind, title, "
            " evidence_json, interpretation, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
            (uuid.uuid4().hex, session_id, f.get("source_run_id"), f.get("category"),
             f.get("severity"), f.get("confidence"), f.get("kind"),
             redact_text(str(f.get("title", "")))[:300], _dumps(f.get("evidence", {})),
             redact_text(str(f.get("interpretation", "")))[:600], utcnow()),
        )
    conn.commit()


def list_findings(conn: sqlite3.Connection, session_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM session_findings WHERE session_id = ? AND status = 'active' ORDER BY rowid",
        (session_id,),
    ).fetchall()
    return [dict(r) for r in rows]


# --- summary ----------------------------------------------------------------


def upsert_summary(conn: sqlite3.Connection, session_id: str, summary: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO session_summaries "
        "(session_id, summary_md, known_facts_json, open_questions_json, next_actions_json, "
        " findings_json, limitations_json, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(session_id) DO UPDATE SET "
        " summary_md=excluded.summary_md, known_facts_json=excluded.known_facts_json, "
        " open_questions_json=excluded.open_questions_json, next_actions_json=excluded.next_actions_json, "
        " findings_json=excluded.findings_json, limitations_json=excluded.limitations_json, "
        " updated_at=excluded.updated_at",
        (session_id, redact_text(summary.get("summary_md", "")),
         _dumps(summary.get("known_facts", [])), _dumps(summary.get("open_questions", [])),
         _dumps(summary.get("next_actions", [])), _dumps(summary.get("findings", [])),
         _dumps(summary.get("limitations", [])), utcnow()),
    )
    _touch(conn, session_id)
    conn.commit()


def get_summary(conn: sqlite3.Connection, session_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM session_summaries WHERE session_id = ?", (session_id,)).fetchone()
    if row is None:
        return None
    # Same tolerance as the message loader: a damaged column costs its own
    # field, never the whole session (`GET /sessions/{id}` reads this).
    return {
        "session_id": session_id,
        "summary_md": row["summary_md"] or "",
        "known_facts": _loads(row["known_facts_json"], []),
        "open_questions": _loads(row["open_questions_json"], []),
        "next_actions": _loads(row["next_actions_json"], []),
        "findings": _loads(row["findings_json"], []),
        "limitations": _loads(row["limitations_json"], []),
        "updated_at": row["updated_at"],
    }


# --- messages ---------------------------------------------------------------


def add_message(
    conn: sqlite3.Connection,
    session_id: str,
    role: str,
    content: str,
    referenced_run_ids: list[str] | None = None,
    referenced_evidence_ids: list[str] | None = None,
    tool_activity: list[dict[str, Any]] | None = None,
    grounding: dict[str, Any] | None = None,
    proposed_actions: list[dict[str, Any]] | None = None,
    turn_items: list[dict[str, Any]] | None = None,
) -> str:
    msg_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO session_messages "
        "(id, session_id, role, content, referenced_run_ids, referenced_evidence_ids, "
        " tool_activity, grounding, proposed_actions, turn_items, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        # The JSON columns go through redact() like every sibling repo
        # (replace_findings / upsert_summary / create_case): the agent runtime
        # sanitizes upstream, but rule 14 wants the persistence boundary to hold
        # on its own — defense in depth, not the only line.
        (msg_id, session_id, role, redact_text(content or ""),
         json.dumps(referenced_run_ids or []), json.dumps(referenced_evidence_ids or []),
         _dumps(tool_activity or []),
         _dumps(grounding) if grounding is not None else None,
         _dumps(proposed_actions) if proposed_actions is not None else None,
         _dumps(_bounded_turn_items(turn_items)) if turn_items else None,
         utcnow()),
    )
    _touch(conn, session_id)
    conn.commit()
    return msg_id


_MAX_TURN_ITEMS = 200
_MAX_TURN_ITEM_TEXT = 4000


def _bounded_turn_items(items: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """The assistant turn's ordered transcript items, bounded and redacted.

    ``message`` items carry the commentary text; ``tool`` items reference the
    tool_activity record by id (the record itself is the single source of the
    call's truth). Anything else is dropped."""
    out: list[dict[str, Any]] = []
    for it in (items or [])[:_MAX_TURN_ITEMS]:
        if not isinstance(it, dict):
            continue
        kind = it.get("kind")
        if kind == "message":
            text = redact_text(str(it.get("text") or ""))[:_MAX_TURN_ITEM_TEXT]
            if text.strip():
                out.append({"kind": "message", "text": text})
        elif kind == "tool" and it.get("id"):
            out.append({"kind": "tool", "id": str(it["id"])[:64]})
    return out


# --- agent working memory ---------------------------------------------------
#
# Facts/findings/open-questions the in-chat agent records itself as it
# investigates (kind in {'fact','finding','open_question'}). Kept separate from
# the deterministic session_findings/session_summaries (which are rebuilt from
# run artifacts and would wipe these). Always redacted; never secrets/raw rows.

_MEMORY_KINDS = ("fact", "finding", "open_question")


def add_agent_memory(
    conn: sqlite3.Connection,
    session_id: str,
    kind: str,
    text: str,
    *,
    severity: str | None = None,
    confidence: str | None = None,
    source_run_id: str | None = None,
) -> str:
    """Persist one agent-authored memory item (sanitized). Returns its id.

    Deduped: an exact-duplicate ACTIVE item of the same kind/text is not
    re-inserted — the existing id is returned instead, so a re-derived fact
    doesn't pile up identical rows against the tail cap.
    """
    if kind not in _MEMORY_KINDS:
        raise ValueError(f"unknown agent-memory kind: {kind!r}")
    clean = redact_text(str(text))[:600]
    existing = conn.execute(
        "SELECT id FROM session_agent_memory "
        "WHERE session_id = ? AND kind = ? AND text = ? AND status = 'active' LIMIT 1",
        (session_id, kind, clean),
    ).fetchone()
    if existing is not None:
        return existing["id"]
    mem_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO session_agent_memory "
        "(id, session_id, kind, text, severity, confidence, source_run_id, status, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)",
        (mem_id, session_id, kind, clean,
         (severity or None), (confidence or None), (source_run_id or None), utcnow()),
    )
    _touch(conn, session_id)
    conn.commit()
    return mem_id


def update_agent_memory(
    conn: sqlite3.Connection, session_id: str, mem_id: str, new_text: str
) -> bool:
    """Correct an active memory item's text (sanitized). Returns True if updated."""
    clean = redact_text(str(new_text))[:600]
    cur = conn.execute(
        "UPDATE session_agent_memory SET text = ? "
        "WHERE id = ? AND session_id = ? AND status = 'active'",
        (clean, mem_id, session_id),
    )
    _touch(conn, session_id)
    conn.commit()
    return cur.rowcount > 0


def resolve_agent_memory(
    conn: sqlite3.Connection, session_id: str, mem_id: str, reason: str | None = None
) -> bool:
    """Close/resolve a memory item so it stops being replayed and no longer
    counts against the active tail cap. Returns True if a row was resolved.

    The optional ``reason`` is appended (sanitized) to the item's text so the
    resolution stays auditable even though the item leaves the active set.
    """
    row = conn.execute(
        "SELECT text FROM session_agent_memory "
        "WHERE id = ? AND session_id = ? AND status = 'active'",
        (mem_id, session_id),
    ).fetchone()
    if row is None:
        return False
    text = row["text"]
    if reason:
        text = f"{text} [resolved: {redact_text(str(reason))[:200]}]"[:600]
    conn.execute(
        "UPDATE session_agent_memory SET status = 'resolved', text = ? "
        "WHERE id = ? AND session_id = ?",
        (text, mem_id, session_id),
    )
    _touch(conn, session_id)
    conn.commit()
    return True


def list_agent_memory(
    conn: sqlite3.Connection, session_id: str, limit: int = 50
) -> list[dict[str, Any]]:
    """The most recent ``limit`` ACTIVE agent-memory items, returned oldest-first.

    Resolved/closed items are excluded (they neither replay into context nor
    count against the tail cap). Bounded so a long-running session can't grow the
    per-turn context (or its build cost) without limit; the newest items survive.
    """
    rows = conn.execute(
        "SELECT * FROM session_agent_memory WHERE session_id = ? AND status = 'active' "
        "ORDER BY rowid DESC LIMIT ?",
        (session_id, max(1, int(limit))),
    ).fetchall()
    return [dict(r) for r in reversed(rows)]


def count_agent_memory(conn: sqlite3.Connection, session_id: str) -> dict[str, int]:
    """ACTIVE agent-memory counts per kind.

    ``list_agent_memory`` tail-caps, which is right for the prompt (a bounded
    context) and right for the UI panel (it shows exactly what the agent
    replays) — but wrong for the REPORT, which would otherwise drop the oldest
    items and say nothing. This is how the report states what it left out."""
    rows = conn.execute(
        "SELECT kind, count(*) n FROM session_agent_memory "
        "WHERE session_id = ? AND status = 'active' GROUP BY kind",
        (session_id,),
    ).fetchall()
    return {r["kind"]: int(r["n"]) for r in rows}


# How many messages a thread returns by default. A long investigation is worth
# keeping in one session, but the whole history is not worth re-sending on every
# open AND every turn: at 300 turns the full thread is ~1 MiB of JSON, and it
# grows without bound. The client asks for older pages when the user scrolls up.
DEFAULT_MESSAGE_PAGE = 60
MAX_MESSAGE_PAGE = 500


def _loads(raw: Any, fallback: Any) -> Any:
    """Decode a persisted JSON column, degrading to ``fallback`` if it is not
    readable.

    Every one of these columns is written by this process, so a malformed value
    means a truncated write or a corrupted file — rare, but the failure mode was
    catastrophic and out of proportion: one unreadable trace column raised
    inside the row loop and took down `GET /sessions/{id}` for the WHOLE
    session, so the entire conversation became unopenable because one turn's
    tool trace was damaged. Losing that trace is the honest loss; losing the
    investigation is not.
    """
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return fallback


def count_messages(conn: sqlite3.Connection, session_id: str) -> int:
    return int(conn.execute(
        "SELECT count(*) FROM session_messages WHERE session_id = ?", (session_id,)
    ).fetchone()[0])


def list_messages(conn: sqlite3.Connection, session_id: str,
                  limit: int | None = None, before_rowid: int | None = None
                  ) -> list[dict[str, Any]]:
    """Thread messages in chronological order.

    ``limit`` returns the LAST ``limit`` messages (the tail is what a thread
    opens to); ``before_rowid`` pages backwards from there. ``limit=None`` keeps
    the historical unbounded behaviour for callers that genuinely need it — the
    report builder, which summarises the whole investigation.
    """
    # `rowid` must be selected EXPLICITLY: `SELECT *` omits it, so both the
    # paging cursor and the outer re-sort would silently have nothing to work
    # with (a page that looks correct but never advances).
    if limit is None:
        rows = conn.execute(
            "SELECT rowid AS seq, * FROM session_messages WHERE session_id = ? ORDER BY seq",
            (session_id,),
        ).fetchall()
    else:
        lim = max(1, min(int(limit), MAX_MESSAGE_PAGE))
        if before_rowid is not None:
            rows = conn.execute(
                "SELECT * FROM (SELECT rowid AS seq, * FROM session_messages "
                "               WHERE session_id = ? AND rowid < ? "
                "               ORDER BY seq DESC LIMIT ?) ORDER BY seq",
                (session_id, int(before_rowid), lim),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM (SELECT rowid AS seq, * FROM session_messages "
                "               WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq",
                (session_id, lim),
            ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        keys = r.keys()
        out.append({
            "id": r["id"], "role": r["role"], "content": r["content"],
            # Opaque paging cursor: the client hands the oldest one back as
            # `before` to fetch the page above it.
            "seq": r["seq"] if "seq" in keys else None,
            "referenced_run_ids": _loads(r["referenced_run_ids"], []),
            "referenced_evidence_ids": _loads(r["referenced_evidence_ids"], []),
            "tool_activity": _loads(r["tool_activity"] if "tool_activity" in keys else None, []),
            "grounding": _loads(r["grounding"], None) if "grounding" in keys else None,
            "proposed_actions": _loads(r["proposed_actions"], []) if "proposed_actions" in keys else [],
            "turn_items": _loads(r["turn_items"], []) if "turn_items" in keys else [],
            "created_at": r["created_at"],
        })
    return out
