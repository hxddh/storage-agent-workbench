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

import pytest

from app import config
from app.migrations import MIGRATIONS, apply_migrations


def _fresh_db(path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    return conn


# --- S2: 422 must not leak secrets ------------------------------------------

def test_validation_error_does_not_echo_secrets(client):
    # Omit the required `name` while including credentials → the default FastAPI
    # 422 would echo the whole body (with the secret) in each error's `input`.
    resp = client.post("/cloud-providers", json={
        "provider_type": "aws",
        "access_key": "AKIAEXAMPLE7NOTREAL",
        "secret_key": "SuperSecretValue123/hush",
        "session_token": "tok-abc",
    })
    assert resp.status_code == 422
    assert "SuperSecretValue123" not in resp.text
    assert "AKIAEXAMPLE7NOTREAL" not in resp.text
    # The useful error shape is preserved.
    body = resp.json()
    assert isinstance(body["detail"], list)
    assert any(e.get("loc", [])[-1:] == ["name"] for e in body["detail"])
    assert all("input" not in e for e in body["detail"])


def test_model_provider_validation_error_does_not_echo_api_key(client):
    resp = client.post("/model-providers", json={
        "provider_type": "openai",
        "api_key": "sk-SUPERSECRETMODELKEY9999",
    })
    assert resp.status_code == 422
    assert "sk-SUPERSECRETMODELKEY9999" not in resp.text


# --- D1: session delete removes the on-disk upload tree ----------------------

def test_session_delete_removes_upload_dir(client, tmp_path):
    r = client.post("/sessions", json={"title": "disk test"})
    assert r.status_code in (200, 201)
    sid = r.json()["id"]
    sess_dir = config.data_dir() / "sessions" / sid / "raw"
    sess_dir.mkdir(parents=True, exist_ok=True)
    big = sess_dir / "upload.csv"
    big.write_text("a,b,c\n1,2,3\n")
    assert big.exists()

    assert client.delete(f"/sessions/{sid}").status_code == 204
    assert not (config.data_dir() / "sessions" / sid).exists()


# --- D2: run deletion + orphan sweep -----------------------------------------

def test_delete_run_endpoint_removes_row_and_dir(client):
    from app.db import connect
    from app.models.schemas import RunCreate
    from app.repositories import runs as runs_repo

    conn = connect()
    try:
        run_id = runs_repo.create(
            conn, RunCreate(run_type="account_discovery", provider_id="p1",
                            user_prompt="x"), status="completed")
    finally:
        conn.close()
    run_dir = config.run_dir(run_id)
    (run_dir / "raw").mkdir(parents=True, exist_ok=True)
    (run_dir / "report.md").write_text("# report\n")
    assert run_dir.exists()

    assert client.delete(f"/runs/{run_id}").status_code == 204
    assert not run_dir.exists()
    assert client.get(f"/runs/{run_id}").status_code == 404
    assert client.delete(f"/runs/{run_id}").status_code == 404  # already gone


def test_orphaned_agent_runs_swept(tmp_path):
    from app.models.schemas import RunCreate
    from app.repositories import runs as runs_repo

    conn = _fresh_db(tmp_path / "orphan.db")
    # An agent-origin run whose session never existed (orphaned by a prior delete).
    orphan = runs_repo.create(conn, RunCreate(run_type="account_discovery",
                              provider_id="p", user_prompt="x",
                              session_id="ghost-session"), status="completed", origin="agent")
    # A live session with an agent run — must NOT be swept.
    conn.execute("INSERT INTO sessions (id, title, status, created_at, updated_at) "
                 "VALUES ('live', 't', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
    kept = runs_repo.create(conn, RunCreate(run_type="account_discovery", provider_id="p",
                            user_prompt="x", session_id="live"), status="completed", origin="agent")
    # A user-origin run whose session is gone — preserved (not agent-origin).
    user_run = runs_repo.create(conn, RunCreate(run_type="account_discovery", provider_id="p",
                                user_prompt="x", session_id="ghost-session"), status="completed")
    conn.commit()

    ids = runs_repo.orphaned_agent_run_ids(conn)
    assert orphan in ids
    assert kept not in ids
    assert user_run not in ids


def test_session_delete_returns_agent_run_ids(tmp_path):
    from app.models.schemas import RunCreate
    from app.repositories import runs as runs_repo
    from app.repositories import sessions as sessions_repo

    conn = _fresh_db(tmp_path / "sd.db")
    conn.execute("INSERT INTO sessions (id, title, status, created_at, updated_at) "
                 "VALUES ('s1', 't', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
    agent_run = runs_repo.create(conn, RunCreate(run_type="account_discovery", provider_id="p",
                                 user_prompt="x", session_id="s1"), status="completed", origin="agent")
    user_run = runs_repo.create(conn, RunCreate(run_type="account_discovery", provider_id="p",
                                user_prompt="x", session_id="s1"), status="completed")
    conn.commit()

    removed = sessions_repo.delete(conn, "s1")
    assert removed == [agent_run]
    assert runs_repo.get_row(conn, agent_run) is None      # deleted
    assert runs_repo.get_row(conn, user_run) is not None   # user run preserved


# --- D3: audit retention -----------------------------------------------------

def test_prune_audit_logs_ages_out_old_rows(tmp_path, monkeypatch):
    from app import data_maintenance

    conn = _fresh_db(tmp_path / "audit.db")
    conn.execute("INSERT INTO audit_logs (id, event_type, payload_json_sanitized, created_at) "
                 "VALUES ('old', 'x', '{}', '2000-01-01T00:00:00Z')")
    conn.execute("INSERT INTO audit_logs (id, event_type, payload_json_sanitized, created_at) "
                 "VALUES ('new', 'x', '{}', '2999-01-01T00:00:00Z')")
    conn.commit()

    monkeypatch.setenv("STORAGE_AGENT_AUDIT_RETENTION_DAYS", "365")
    removed = data_maintenance.prune_audit_logs(conn)
    assert removed == 1
    remaining = {r[0] for r in conn.execute("SELECT id FROM audit_logs")}
    assert remaining == {"new"}


def test_audit_retention_disabled_keeps_everything(tmp_path, monkeypatch):
    from app import data_maintenance

    conn = _fresh_db(tmp_path / "audit2.db")
    conn.execute("INSERT INTO audit_logs (id, event_type, payload_json_sanitized, created_at) "
                 "VALUES ('old', 'x', '{}', '2000-01-01T00:00:00Z')")
    conn.commit()
    monkeypatch.setenv("STORAGE_AGENT_AUDIT_RETENTION_DAYS", "0")
    assert data_maintenance.prune_audit_logs(conn) == 0
    assert conn.execute("SELECT count(*) FROM audit_logs").fetchone()[0] == 1


# --- D4: enrichment counts ---------------------------------------------------

def test_enrich_counts_are_correct(tmp_path):
    from app.repositories import sessions as sessions_repo

    conn = _fresh_db(tmp_path / "enrich.db")
    for sid in ("a", "b"):
        conn.execute("INSERT INTO sessions (id, title, status, created_at, updated_at) "
                     f"VALUES ('{sid}', 't', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
    # session a: 2 run links, 1 active finding + 1 resolved (only active counts)
    for i in range(2):
        conn.execute("INSERT INTO runs (id, run_type, status, created_at, updated_at) "
                     f"VALUES ('run{i}', 'account_discovery', 'completed', "
                     "'2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
        conn.execute("INSERT INTO session_runs (id, session_id, run_id, created_at) "
                     f"VALUES ('r{i}', 'a', 'run{i}', '2026-01-01T00:00:00Z')")
    conn.execute("INSERT INTO session_findings (id, session_id, status, created_at) "
                 "VALUES ('f1', 'a', 'active', '2026-01-01T00:00:00Z')")
    conn.execute("INSERT INTO session_findings (id, session_id, status, created_at) "
                 "VALUES ('f2', 'a', 'resolved', '2026-01-01T00:00:00Z')")
    conn.commit()

    by_id = {s["id"]: s for s in sessions_repo.list_all(conn)}
    assert by_id["a"]["run_count"] == 2
    assert by_id["a"]["finding_count"] == 1
    assert by_id["b"]["run_count"] == 0
    assert by_id["b"]["finding_count"] == 0


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


def test_all_migrations_apply(tmp_path):
    conn = _fresh_db(tmp_path / "mig.db")
    assert apply_migrations(conn) == 0  # already applied by _fresh_db
    # Retention indexes exist.
    idx = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index'")}
    assert "idx_audit_logs_created" in idx
    assert len(MIGRATIONS) == 19
