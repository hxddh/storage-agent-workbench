"""One-shot import of a v4 database into v5.

v5 starts a fresh `storage-agent.db`. On first start, when a v4 `app.db` sits
beside it, this copies what the user would miss — never modifying `app.db`:

- model endpoints and storage accounts (the vault references carry over; the
  secrets themselves never move);
- the estate: known buckets, issues with their lifecycle, watch schedules;
- the price table;
- each task's title and, for every Direction, its final answer and recorded
  conclusion (the tool trace stays in v4 — the task says it was imported).

Runs once (the ``settings`` key ``imported_from_v4`` records it), bounded, and
never fails startup: an unreadable v4 file is skipped with a log line.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any

from . import config
from .core import store
from .core.clock import utcnow
from .providers.models import default_api_style

logger = logging.getLogger(__name__)

MAX_TASKS = 500
MAX_MESSAGES_PER_TASK = 400
_KINDS = {"openai", "anthropic", "deepseek", "openrouter", "ollama", "lmstudio", "vllm", "llamacpp",
          "openai-compatible"}
_KIND_ALIASES = {"llama.cpp": "llamacpp", "llama_cpp": "llamacpp", "lm-studio": "lmstudio",
                 "openai_compatible": "openai-compatible", "custom": "openai-compatible"}
_MARK = "imported_from_v4"


def _cols(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.DatabaseError:
        return set()


def _rows(conn: sqlite3.Connection, sql: str, args: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
    try:
        return conn.execute(sql, args).fetchall()
    except sqlite3.DatabaseError:
        return []


def _json(raw: Any) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def run_once(conn: sqlite3.Connection) -> dict[str, int] | None:
    """Import from app.db if it exists and nothing was imported yet."""
    if conn.execute("SELECT 1 FROM settings WHERE key = ?", (_MARK,)).fetchone():
        return None
    legacy = config.legacy_db_path()
    if not legacy.exists() or legacy.resolve() == config.db_path().resolve():
        return None
    has_data = conn.execute("SELECT (SELECT count(*) FROM tasks) + (SELECT count(*) FROM model_providers) "
                            "+ (SELECT count(*) FROM cloud_providers)").fetchone()[0]
    counts: dict[str, int] = {}
    if not has_data:
        try:
            old = sqlite3.connect(f"file:{legacy}?mode=ro", uri=True)
            old.row_factory = sqlite3.Row
            try:
                counts = _import(old, conn)
            finally:
                old.close()
        except sqlite3.DatabaseError as exc:
            logger.warning("v4 import failed (%s); it is retried on the next start", type(exc).__name__)
            conn.rollback()
            return None
    conn.execute("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
                 (_MARK, json.dumps(counts), utcnow()))
    conn.commit()
    return counts


def _import(old: sqlite3.Connection, new: sqlite3.Connection) -> dict[str, int]:
    counts = {"model_providers": 0, "cloud_providers": 0, "tasks": 0, "buckets": 0, "issues": 0}

    for i, r in enumerate(_rows(old, "SELECT * FROM model_providers ORDER BY created_at")):
        kind = str(r["provider_type"] or "openai").strip().lower()
        kind = _KIND_ALIASES.get(kind, kind)
        kind = kind if kind in _KINDS else "openai-compatible"
        new.execute("INSERT OR IGNORE INTO model_providers (id, name, kind, base_url, model, api_key_ref, api_style, "
                    "context_window, max_output_tokens, reasoning_effort, active, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (r["id"], r["name"], kind, r["base_url"], r["model"], r["api_key_ref"],
                     default_api_style(kind, r["base_url"]), r["context_window"], r["max_output_tokens"],
                     r["reasoning_effort"], 1 if i == 0 else 0, r["created_at"], r["updated_at"]))
        counts["model_providers"] += 1

    for r in _rows(old, "SELECT * FROM cloud_providers ORDER BY created_at"):
        new.execute("INSERT OR IGNORE INTO cloud_providers (id, name, provider_type, endpoint_url, region, "
                    "addressing_style, signature_version, access_key_ref, secret_key_ref, session_token_ref, "
                    "allowed_buckets_json, allowed_prefixes_json, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (r["id"], r["name"], r["provider_type"], r["endpoint_url"], r["region"], r["addressing_style"],
                     r["signature_version"], r["access_key_ref"], r["secret_key_ref"], r["session_token_ref"],
                     r["allowed_buckets_json"] or "[]", r["allowed_prefixes_json"] or "[]", r["created_at"],
                     r["updated_at"]))
        counts["cloud_providers"] += 1

    prices = _rows(old, "SELECT * FROM storage_price_table WHERE id = 'default'")
    if prices:
        doc = {"rates": _json(prices[0]["rates_json"]), "confirmed": bool(prices[0]["confirmed"]),
               "note": prices[0]["note"]}
        if isinstance(doc["rates"], dict):
            new.execute("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('price_table', ?, ?)",
                        (json.dumps(doc), prices[0]["updated_at"] or utcnow()))

    task_ids = _import_tasks(old, new, counts)

    for r in _rows(old, "SELECT * FROM estate_buckets"):
        # INSERT … SELECT … WHERE EXISTS: an orphan v4 row (its provider gone) is
        # skipped instead of violating a foreign key and rolling everything back.
        n = new.execute("INSERT OR IGNORE INTO estate_buckets (provider_id, bucket, region, posture, "
                        "last_checked_at, source_task_id) SELECT ?, ?, ?, ?, ?, ? "
                        "WHERE EXISTS (SELECT 1 FROM cloud_providers WHERE id = ?)",
                        (r["provider_id"], r["bucket"], r["region"], r["posture_json_sanitized"],
                         r["last_checked_at"], r["source_task_id"] if r["source_task_id"] in task_ids else None,
                         r["provider_id"])).rowcount
        counts["buckets"] += max(n, 0)
    for r in _rows(old, "SELECT * FROM issues"):
        n = new.execute("INSERT OR IGNORE INTO issues (id, provider_id, bucket, code, fingerprint, severity, status, "
                        "detail, first_seen_at, last_seen_at, resolved_at, resolved_by, source_task_id, fix, "
                        "last_verified_at, last_verify_result, updated_at) "
                        "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? "
                        "WHERE EXISTS (SELECT 1 FROM cloud_providers WHERE id = ?)",
                        (r["id"], r["provider_id"], r["bucket"], r["code"], r["fingerprint"], r["severity"],
                         r["status"], r["detail_sanitized"], r["first_seen_at"], r["last_seen_at"], r["resolved_at"],
                         r["resolved_by"], r["source_task_id"] if r["source_task_id"] in task_ids else None,
                         r["fix_json_sanitized"], r["last_verified_at"], r["last_verify_result"], r["updated_at"],
                         r["provider_id"])).rowcount
        counts["issues"] += max(n, 0)
    for r in _rows(old, "SELECT * FROM issue_events ORDER BY id"):
        new.execute("INSERT INTO issue_events (issue_id, kind, source, detail, created_at) "
                    "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM issues WHERE id = ?)",
                    (r["issue_id"], r["kind"], r["source"], r["detail_json_sanitized"], r["created_at"],
                     r["issue_id"]))
    for r in _rows(old, "SELECT * FROM watch_schedules"):
        new.execute("INSERT OR IGNORE INTO watch_schedules (provider_id, enabled, interval_hours, next_run_at, "
                    "last_run_at, last_status, last_summary, last_task_id, updated_at) "
                    "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cloud_providers WHERE id = ?)",
                    (r["provider_id"], r["enabled"], r["interval_hours"], r["next_run_at"], r["last_run_at"],
                     r["last_status"], r["last_summary_sanitized"],
                     r["last_task_id"] if r["last_task_id"] in task_ids else None, r["updated_at"], r["provider_id"]))
    new.commit()
    logger.info("imported from v4: %s", counts)
    return counts


def _import_tasks(old: sqlite3.Connection, new: sqlite3.Connection, counts: dict[str, int]) -> set[str]:
    has_conclusion = "conclusion" in _cols(old, "session_messages")
    title_source = "title_source" in _cols(old, "sessions")
    ids: set[str] = set()
    for s in _rows(old, "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?", (MAX_TASKS,)):
        tid = s["id"]
        src = (s["title_source"] if title_source else None) or "seed"
        new.execute("INSERT OR IGNORE INTO tasks (id, title, title_source, origin, created_at, updated_at) "
                    "VALUES (?, ?, ?, 'user', ?, ?)",
                    (tid, (s["title"] or "Imported task")[:120], src if src in ("seed", "agent", "user") else "seed",
                     s["created_at"], s["updated_at"]))
        parent: str | None = None
        turn_id: str | None = None
        msgs = _rows(old, "SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at, rowid LIMIT ?",
                     (tid, MAX_MESSAGES_PER_TASK))
        for m in msgs:
            if m["role"] == "user":
                turn_id = store.new_id()
                new.execute("INSERT INTO turns (id, task_id, parent_turn_id, kind, direction, status, created_at, "
                            "started_at, finished_at) VALUES (?, ?, ?, 'direction', ?, 'completed', ?, ?, ?)",
                            (turn_id, tid, parent, (m["content"] or "")[:16000], m["created_at"], m["created_at"],
                             m["created_at"]))
                store.append_item(new, tid, turn_id, "user_message", {"text": m["content"] or ""}, commit=False)
                if parent is None:
                    store.append_item(new, tid, turn_id, "notice", {"event": "imported", "from": "v4"},
                                      commit=False)
                parent = turn_id
            elif m["role"] == "assistant" and turn_id is not None:
                if has_conclusion and m["conclusion"]:
                    c = _json(m["conclusion"])
                    if isinstance(c, dict) and c.get("answer"):
                        store.append_item(new, tid, turn_id, "conclusion",
                                          {"call_id": f"imported-{m['id']}", "answer": c.get("answer"),
                                           "findings": c.get("findings") or [],
                                           "next_steps": c.get("next_steps") or []}, commit=False)
                store.append_item(new, tid, turn_id, "agent_message", {"text": m["content"] or ""}, commit=False)
        if parent is not None:
            new.execute("UPDATE tasks SET head_turn_id = ? WHERE id = ?", (parent, tid))
        ids.add(tid)
        counts["tasks"] += 1
    return ids
