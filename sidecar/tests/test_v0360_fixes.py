"""v0.36.0 — migration crash-recovery for table-rebuild migrations.

A table-rebuild migration (``CREATE <new> / INSERT..SELECT / DROP <final> /
RENAME <new>→<final>``) that crashes mid-way — power loss, kill, OOM — leaves the
DB in a partial state with the migration's version row unwritten. On the next
boot ``apply_migrations`` re-runs the whole migration. Two of these rebuilds
(``_M002`` tool_calls, ``_M004`` datasets) then WEDGE the app forever:

  * ``_M004`` renames COLUMNS (``kind → dataset_type``), so its ``INSERT..SELECT``
    names the OLD columns. Once the rename has happened, a retry copies from the
    NEW-schema table and raises ``no such column: kind`` — not an idempotent
    marker — so every boot fails and the app never starts.
  * The naive fix (tolerating that error) would DROP the populated rebuilt table
    and rename an empty one in — silent data loss.

``_recover_table_rebuild`` recognizes each crash window from the on-disk SCHEMA
and either finishes the rebuild or re-runs it from the intact table, without
losing rows. This test drives EVERY crash window of both rebuilds and asserts
the seeded rows survive with the rebuilt shape.
"""

from __future__ import annotations

import sqlite3

import pytest

from app.migrations import (
    MIGRATIONS,
    _apply_one,
    _recover_table_rebuild,
    _statements,
)


def _mig(version: int) -> str:
    return next(sql for v, _n, sql in MIGRATIONS if v == version)


def _db_upto(path, up_to: int) -> sqlite3.Connection:
    """A DB with migrations 1..up_to applied and their version rows recorded."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, "
                 "name TEXT NOT NULL, applied_at TEXT NOT NULL)")
    for v, n, sql in MIGRATIONS:
        if v > up_to:
            break
        _apply_one(conn, sql)
        conn.execute("INSERT INTO schema_migrations VALUES (?, ?, 't')", (v, n))
    conn.commit()
    return conn


def _seed(conn: sqlite3.Connection) -> None:
    conn.execute("INSERT INTO runs (id, run_type, status, created_at, updated_at) "
                 "VALUES ('r1','diagnostic','completed','t','t')")
    conn.execute("INSERT INTO tool_calls (id, run_id, tool_name, input_json_sanitized, "
                 "output_json_sanitized, status, duration_ms, created_at) "
                 "VALUES ('tc1','r1','head_bucket','{}','{}','ok',5,'t')")
    conn.execute("INSERT INTO datasets (id, run_id, kind, source_path, row_count, created_at) "
                 "VALUES ('ds1','r1','access_log','/x',10,'t')")
    conn.commit()


def _crash_and_recover(conn, migration_sql, k):
    """Execute the first ``k`` statements (the crash window), then re-run the whole
    migration as ``apply_migrations`` would on the next boot."""
    for stmt in _statements(migration_sql)[:k]:
        try:
            conn.execute(stmt)
        except sqlite3.Error:
            pass  # a partial statement may itself fail; that's the crash
    conn.commit()
    _apply_one(conn, migration_sql)  # must NOT raise — recovery handles it


# --- _M004 (datasets): rename-columns rebuild, the wedging one ---------------

@pytest.mark.parametrize("k", range(0, len(_statements(_mig(4))) + 1))
def test_m004_recovers_every_crash_window_with_data(tmp_path, k):
    conn = _db_upto(tmp_path / f"m004_{k}.db", up_to=3)
    _seed(conn)
    _crash_and_recover(conn, _mig(4), k)

    ds = conn.execute("SELECT * FROM datasets WHERE id='ds1'").fetchone()
    assert ds is not None, f"row lost at crash window {k}"
    assert ds["dataset_type"] == "access_log"   # kind → dataset_type
    assert ds["stored_path"] == "/x"            # source_path → stored_path
    assert ds["row_count"] == 10
    assert "kind" not in ds.keys()              # rebuilt shape, not the old one
    conn.close()


# --- _M002 (tool_calls): constraint-only rebuild (run_id → nullable) ---------

@pytest.mark.parametrize("k", range(0, len(_statements(_mig(2))) + 1))
def test_m002_recovers_every_crash_window_with_data(tmp_path, k):
    conn = _db_upto(tmp_path / f"m002_{k}.db", up_to=1)
    _seed(conn)
    _crash_and_recover(conn, _mig(2), k)

    tc = conn.execute("SELECT * FROM tool_calls WHERE id='tc1'").fetchone()
    assert tc is not None, f"row lost at crash window {k}"
    assert tc["tool_name"] == "head_bucket" and tc["duration_ms"] == 5
    # the whole point of _M002: run_id is now nullable (ad-hoc tool calls).
    conn.execute("INSERT INTO tool_calls (id, tool_name, status, created_at) "
                 "VALUES ('tc2','x','ok','t')")
    conn.commit()
    conn.close()


# --- fallback branch: <new> gone, constraint-only rebuild not yet applied -----

def test_recover_does_not_falsely_complete_a_constraint_only_rebuild(tmp_path):
    """The ``<new>``-gone fallback compares the rebuilt shape by (name, notnull),
    not names alone — so a constraint-only rebuild like _M002 (run_id → nullable,
    column names UNCHANGED) is NOT mistaken for already-complete when the table is
    still the un-rebuilt original. A name-only comparison returned True here and
    would have marked the migration applied with run_id still NOT NULL."""
    conn = sqlite3.connect(tmp_path / "old.db")
    _apply_one(conn, _mig(1))  # only the pre-rebuild schema: tool_calls.run_id NOT NULL
    m002 = _mig(2)

    # Directly probe the recovery on the intact OLD table (this is the branch a
    # future constraint-only rebuild placed after a failing statement could hit).
    assert _recover_table_rebuild(conn, m002) is False  # NOT "already complete"

    # And it must leave the old table intact for the generic replay to rebuild from.
    notnull = {r[1]: r[3] for r in conn.execute("PRAGMA table_info(tool_calls)")}
    assert notnull["run_id"] == 1  # untouched; still the old NOT NULL shape
    conn.close()
