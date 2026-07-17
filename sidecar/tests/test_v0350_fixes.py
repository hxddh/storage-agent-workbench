"""v0.35.0 — report-artifact injection + upgrade-survival regression.

  R1  Markdown report table cells are escaped, so an attacker-influenceable
      object key / user-agent can't break the table or inject HTML into the saved
      .md artifact.
  M   an OLD-schema DB with real rows in the rebuilt tables (tool_calls @ M002,
      datasets @ M004) survives a full upgrade with its data intact — a
      regression guard for the migration replay that had no coverage.
"""

from __future__ import annotations

import sqlite3

from app.migrations import MIGRATIONS, _apply_one, apply_migrations
from app.runs import analysis_report as ar


# --- R1: report table cells are escaped --------------------------------------

def test_table_cell_escapes_pipe_and_html():
    md = ar._table(["Key", "Size"], [["a|b", "5 GB"], ["<img src=x onerror=alert(1)>", "1 GB"]])
    lines = md.splitlines()
    # Header + separator + exactly one body row per input row (a newline/pipe must
    # NOT split a row or add columns).
    assert len(lines) == 4
    for line in lines[2:]:
        # every body row has exactly 2 columns (3 pipes) — the `|` in "a|b" is escaped.
        assert line.count("|") - line.count("\\|") == 3
    assert "\\|" in md                     # literal pipe escaped
    assert "&lt;img" in md and "<img" not in md  # HTML neutralized


def test_table_cell_escapes_newline():
    md = ar._table(["Key"], [["line1\nline2"]])
    # The embedded newline must not create a second table row.
    assert len(md.splitlines()) == 3  # header, sep, one body row
    assert "line1 line2" in md


# --- M: old-schema DB upgrades with data intact ------------------------------

def test_old_db_upgrade_preserves_rebuilt_table_rows(tmp_path):
    conn = sqlite3.connect(tmp_path / "old.db")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, "
                 "name TEXT NOT NULL, applied_at TEXT NOT NULL)")
    # Apply ONLY migration 1 (the pre-rebuild schema), then seed rows into the
    # tables that later migrations REBUILD (tool_calls @ M002, datasets @ M004).
    v1 = next(sql for v, _n, sql in MIGRATIONS if v == 1)
    _apply_one(conn, v1)
    conn.execute("INSERT INTO schema_migrations VALUES (1, 'initial_schema', 't')")
    conn.execute("INSERT INTO runs (id, run_type, status, created_at, updated_at) "
                 "VALUES ('r1', 'diagnostic', 'completed', 't', 't')")
    conn.execute("INSERT INTO tool_calls (id, run_id, tool_name, input_json_sanitized, "
                 "output_json_sanitized, status, duration_ms, created_at) "
                 "VALUES ('tc1', 'r1', 'head_bucket', '{}', '{}', 'ok', 5, 't')")
    conn.execute("INSERT INTO datasets (id, run_id, kind, source_path, row_count, created_at) "
                 "VALUES ('ds1', 'r1', 'access_log', '/x', 10, 't')")
    conn.commit()

    # Upgrade: apply every remaining migration.
    applied = apply_migrations(conn)
    assert applied == len(MIGRATIONS) - 1

    tc = conn.execute("SELECT * FROM tool_calls WHERE id = 'tc1'").fetchone()
    assert tc is not None and tc["tool_name"] == "head_bucket" and tc["duration_ms"] == 5
    ds = conn.execute("SELECT * FROM datasets WHERE id = 'ds1'").fetchone()
    # M004 maps kind→dataset_type and source_path→stored_path; row_count preserved.
    assert ds is not None
    assert ds["dataset_type"] == "access_log"
    assert ds["stored_path"] == "/x"
    assert ds["row_count"] == 10
    assert conn.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] == len(MIGRATIONS)
    conn.close()
