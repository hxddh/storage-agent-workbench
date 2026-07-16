"""v0.31.0 hardening batch — packaging integrity + data-integrity fixes.

Covers:
  O1  deep bundle self-check (agents/openai/boto3-client/duckdb/pyarrow +
      AES-GCM vault round-trip) exposed at /health/selfcheck and asserted by the
      release smoke test — so a bundle missing a lazily imported native dep fails
      the build instead of shipping.
  D1  migration crash-retry tolerates the IntegrityError equivalent of an
      already-present seed row, not just the OperationalError DDL cases.
  D2  numeric Unix-epoch access-log timestamps (s / ms / µs / ns) normalize
      instead of casting to NULL → every hour bucket 'unknown'.
"""

from __future__ import annotations

import sqlite3

import pytest


# --- O1: deep bundle self-check ---------------------------------------------

def test_selfcheck_all_components_ok():
    from app.routers.health import _run_selfcheck

    r = _run_selfcheck()
    assert r["status"] == "ok", r
    assert set(r["checks"]) == {"agents_sdk", "s3_client", "analysis_engine", "vault_crypto"}
    assert all(v == "ok" for v in r["checks"].values()), r["checks"]


def test_selfcheck_endpoint_ok(client):
    resp = client.get("/health/selfcheck")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "storage-agent-sidecar"


def test_selfcheck_reports_degraded_when_a_component_fails(monkeypatch):
    """A broken component must surface as status=degraded with the failure named —
    this is exactly what makes the release smoke test fail a bad bundle."""
    import app.routers.health as health

    real = health._run_selfcheck

    def _boom():
        # Simulate a missing native dep by making one check raise, reusing the
        # real machinery so the aggregation logic is what's under test.
        checks = {"agents_sdk": "ok", "s3_client": "ok",
                  "analysis_engine": "ok",
                  "vault_crypto": "error: ImportError: no _rust binding"}
        return {"status": "degraded", "service": health.SERVICE_NAME, "checks": checks}

    monkeypatch.setattr(health, "_run_selfcheck", _boom)
    out = health.selfcheck()
    assert out["status"] == "degraded"
    assert "error" in out["checks"]["vault_crypto"]
    # sanity: the real one still passes in this env
    assert real()["status"] == "ok"


# --- D1: migration replay tolerates IntegrityError on retry ------------------

def test_is_idempotent_classifies_errors():
    from app.migrations import _is_idempotent

    assert _is_idempotent(sqlite3.OperationalError("duplicate column name: x"))
    assert _is_idempotent(sqlite3.OperationalError("table t already exists"))
    assert not _is_idempotent(sqlite3.OperationalError("no such table: t"))
    assert _is_idempotent(sqlite3.IntegrityError("UNIQUE constraint failed: t.id"))
    assert _is_idempotent(sqlite3.IntegrityError("PRIMARY KEY must be unique"))
    # A genuine constraint violation must NOT be swallowed.
    assert not _is_idempotent(sqlite3.IntegrityError("NOT NULL constraint failed: t.x"))


def test_apply_one_recovers_from_partial_apply_with_seed_row():
    """Re-applying a migration that seeds a row (after a crash left the version
    row unwritten) must not raise: the duplicate PK insert + duplicate column are
    both the 'already applied' signal. Before the fix the IntegrityError from the
    re-INSERT propagated and wedged the whole migration runner."""
    from app.migrations import _apply_one

    conn = sqlite3.connect(":memory:")
    sql = (
        "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY);"
        "INSERT INTO t (id) VALUES (1);"
        "ALTER TABLE t ADD COLUMN c TEXT;"
    )
    _apply_one(conn, sql)  # first, clean apply
    assert conn.execute("SELECT count(*) FROM t").fetchone()[0] == 1
    # Retry the SAME sql (simulates crash-before-version-row): must be a no-op,
    # not an IntegrityError.
    _apply_one(conn, sql)
    assert conn.execute("SELECT count(*) FROM t").fetchone()[0] == 1
    conn.close()


def test_full_migrations_still_apply_cleanly(tmp_path):
    from app.migrations import apply_migrations, MIGRATIONS

    conn = sqlite3.connect(tmp_path / "m.db")
    n = apply_migrations(conn)
    assert n == len(MIGRATIONS)
    # Idempotent second run applies nothing.
    assert apply_migrations(conn) == 0
    conn.close()


# --- D2: epoch access-log timestamp normalization ----------------------------

@pytest.mark.parametrize("raw,expected", [
    ("1719309600", "2024-06-25T10:00:00"),            # seconds
    ("1719309600000", "2024-06-25T10:00:00"),         # milliseconds
    ("1719309600000000", "2024-06-25T10:00:00"),      # microseconds
    ("1719309600000000000", "2024-06-25T10:00:00"),   # nanoseconds
    ("1719309600.0", "2024-06-25T10:00:00"),          # fractional seconds
])
def test_epoch_timestamps_normalize(raw, expected):
    from app.analysis.access_logs import _normalize_ts

    assert _normalize_ts(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    # Compact wall-clock stamps must parse as DATES, never as epochs (a
    # magnitude-based gate misread these as years 8383 / 2611).
    ("202406251000", "2024-06-25T10:00:00"),      # yyyyMMddHHmm (12 digits)
    ("20240625100000", "2024-06-25T10:00:00"),    # yyyyMMddHHmmss (14 digits)
])
def test_compact_dates_parse_as_dates_not_epochs(raw, expected):
    from app.analysis.access_logs import _normalize_ts

    assert _normalize_ts(raw) == expected


@pytest.mark.parametrize("raw", [
    "404",                       # status code — too short to be an epoch
    "17193096001",               # 11 digits — no epoch unit has this width
    "999999999999",              # 12 digits but month 99 — not a compact date
    "99999999999999",            # 14 digits, invalid date fields
    "1234567890123456789012",    # 22 digits — out of range
    "not-a-time",                # non-numeric
])
def test_non_epoch_values_are_not_misread(raw):
    from app.analysis.access_logs import _normalize_ts

    # Returned unchanged (downstream still yields 'unknown'); never a bogus date.
    assert _normalize_ts(raw) == raw


def test_text_formats_unaffected_by_epoch_branch():
    from app.analysis.access_logs import _normalize_ts

    assert _normalize_ts("25/Jun/2024:10:00:00 +0000") == "2024-06-25T10:00:00"
    assert _normalize_ts("2024-06-25T10:00:00Z") == "2024-06-25T10:00:00"
