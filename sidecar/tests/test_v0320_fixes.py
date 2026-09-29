"""v0.32.0 — security fixes + data-lifecycle reclamation.

  S2  422 validation errors must not echo the plaintext request body (which on
      provider-create carries access/secret keys) into the response or UI.
  D1  session delete removes the session's on-disk upload tree.
  D2  runs are deletable (endpoint + repo) with their dirs; orphaned agent runs
      are swept at startup.
  D3  the write-only audit trail is aged out past a retention window (0=disabled).
  D4  session-rail enrichment counts are correct (now batched, not N+1).
  L2  the packaged entrypoint scrubs OPENAI_LOG so a stray env var can't turn on
      verbose wire logging.
  V3  the package version resolves from metadata, not a rotting literal.
"""

from __future__ import annotations

import sqlite3


from app import config
from app.migrations import MIGRATIONS, apply_migrations


def _fresh_db(path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    return conn


# --- S2: 422 must not leak secrets ------------------------------------------





# --- D1: session delete removes the on-disk upload tree ----------------------



# --- D2: run deletion + orphan sweep -----------------------------------------







# --- D3: audit retention -----------------------------------------------------





# --- D4: enrichment counts ---------------------------------------------------



# --- L2 / V3 -----------------------------------------------------------------

def test_configure_scrubs_openai_log(monkeypatch):
    from app import packaged_main

    monkeypatch.setenv("OPENAI_LOG", "debug")
    args = packaged_main.build_parser().parse_args([])
    packaged_main.configure(args)
    import os
    assert "OPENAI_LOG" not in os.environ


def test_package_version_resolves():
    import app
    assert isinstance(app.__version__, str) and app.__version__


