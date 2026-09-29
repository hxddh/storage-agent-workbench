"""Notes about the estate — what the user and the Agent want remembered.

A note is short text kept on the estate, an account or one bucket. The user
writes, edits and deletes them; the Agent adds them with the ``note`` tool; the
reason a risk was accepted is one. Every note is visible and editable, redacted,
bounded (1 000 chars, 500 notes), and the most recent reach every turn's
estate digest as remembered context — never as instructions.
"""

from __future__ import annotations

import re
import sqlite3
import uuid
from typing import Any

from ..core import store as core_store
from ..core.clock import utcnow
from ..security.redaction import REDACTED, redact_text

MAX_TEXT = 1000
MAX_NOTES = 500
DIGEST_NOTES = 12
DIGEST_TEXT = 280
SOURCES = ("user", "agent", "accept")


# Notes reach every prompt, so a bare secret-shaped token is masked even without
# the access-key-ID hint ``redact_text`` needs (the stream sanitizer's rule).
_BARE_SECRET = re.compile(r"(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])")


class NoteError(ValueError):
    pass


def _clean(text: str) -> str:
    text = _BARE_SECRET.sub(REDACTED, redact_text((text or "").strip()))[:MAX_TEXT].strip()
    if not text:
        raise NoteError("a note needs text")
    return text


def _out(r: sqlite3.Row) -> dict[str, Any]:
    return {"id": r["id"], "provider_id": r["provider_id"], "bucket": r["bucket"], "text": r["text"],
            "source": r["source"], "task_id": r["task_id"], "issue_id": r["issue_id"],
            "created_at": r["created_at"], "updated_at": r["updated_at"]}


def add(conn: sqlite3.Connection, text: str, *, provider_id: str | None = None, bucket: str | None = None,
        source: str = "user", task_id: str | None = None, issue_id: str | None = None,
        commit: bool = True) -> dict[str, Any]:
    if source not in SOURCES:
        raise NoteError("unknown source")
    if bucket and not provider_id:
        raise NoteError("a bucket note names its provider")
    if provider_id and conn.execute("SELECT 1 FROM cloud_providers WHERE id = ?", (provider_id,)).fetchone() is None:
        raise NoteError("unknown provider")
    now = utcnow()
    nid = uuid.uuid4().hex
    conn.execute("INSERT INTO notes (id, provider_id, bucket, text, source, task_id, issue_id, created_at, updated_at) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 (nid, provider_id or None, (bucket or None) and bucket[:255], _clean(text), source,
                  task_id or None, issue_id or None, now, now))
    core_store.audit(conn, actor="agent" if source == "agent" else "user", action="note.add", task_id=task_id,
                     target=nid, commit=False)
    _trim(conn)
    if commit:
        conn.commit()
    return get(conn, nid) or {}


def _trim(conn: sqlite3.Connection) -> None:
    """Keep at most MAX_NOTES: the Agent's oldest notes go first, the user's only
    when nothing else is left to trim. Every trimmed note is audited."""
    over = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0] - MAX_NOTES
    if over <= 0:
        return
    rows = conn.execute("SELECT id FROM notes ORDER BY CASE source WHEN 'agent' THEN 0 ELSE 1 END, updated_at, id "
                        "LIMIT ?", (over,)).fetchall()
    for r in rows:
        conn.execute("DELETE FROM notes WHERE id = ?", (r["id"],))
        core_store.audit(conn, actor="system", action="note.trim", target=r["id"], commit=False)


def drop_accept_reasons(conn: sqlite3.Connection, issue_id: str) -> None:
    for r in conn.execute("SELECT id FROM notes WHERE source = 'accept' AND issue_id = ?", (issue_id,)).fetchall():
        conn.execute("DELETE FROM notes WHERE id = ?", (r["id"],))
        core_store.audit(conn, actor="user", action="note.delete", target=r["id"], commit=False)


def get(conn: sqlite3.Connection, note_id: str) -> dict[str, Any] | None:
    r = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    return _out(r) if r else None


def update(conn: sqlite3.Connection, note_id: str, text: str) -> dict[str, Any] | None:
    n = conn.execute("UPDATE notes SET text = ?, updated_at = ? WHERE id = ?",
                     (_clean(text), utcnow(), note_id)).rowcount
    if n:
        core_store.audit(conn, actor="user", action="note.edit", target=note_id, commit=False)
    conn.commit()
    return get(conn, note_id) if n else None


def delete(conn: sqlite3.Connection, note_id: str) -> bool:
    n = conn.execute("DELETE FROM notes WHERE id = ?", (note_id,)).rowcount
    if n:
        core_store.audit(conn, actor="user", action="note.delete", target=note_id, commit=False)
    conn.commit()
    return n > 0


def list_notes(conn: sqlite3.Connection, *, provider_id: str | None = None, bucket: str | None = None,
               limit: int = 200, exact: bool = False) -> list[dict[str, Any]]:
    """Notes for a scope. A provider scope includes its bucket notes and no scope
    lists all — unless ``exact``: then only the notes on that very scope (the
    estate-wide notes, or an account's own notes)."""
    where, args = [], []
    if exact and not provider_id:
        where.append("provider_id IS NULL")
    if exact and not bucket:
        where.append("bucket IS NULL")
    if provider_id:
        where.append("provider_id = ?")
        args.append(provider_id)
    if bucket:
        where.append("bucket = ?")
        args.append(bucket)
    sql = "SELECT * FROM notes" + (" WHERE " + " AND ".join(where) if where else "")
    rows = conn.execute(sql + " ORDER BY updated_at DESC, id LIMIT ?", (*args, max(1, min(500, int(limit)))))
    return [_out(r) for r in rows.fetchall()]


def digest(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """The most recent notes, shortened — what every turn starts remembering."""
    rows = conn.execute("SELECT * FROM notes ORDER BY updated_at DESC, id LIMIT ?", (DIGEST_NOTES,)).fetchall()
    return [{k: v for k, v in {"note_id": r["id"], "provider_id": r["provider_id"], "bucket": r["bucket"],
                               "by": r["source"], "text": r["text"][:DIGEST_TEXT]}.items() if v}
            for r in rows]
