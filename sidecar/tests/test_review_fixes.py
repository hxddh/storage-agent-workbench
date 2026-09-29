"""Regression tests for the v0.21.x architecture-review fixes.

Each test pins a specific finding from the deep review so the fix can't silently
regress. Grouped by area; see the PR/commit for the full finding list.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from app import config


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(config.db_path())
    conn.row_factory = sqlite3.Row
    return conn


# --- H-4: config-review tools must reach the model with real descriptions -----




# --- H-2 (agent): contract parser must not eat a JSON example in the answer ---




# --- H-2/H3: GET /sessions/{id} must surface grounding + proposed_actions -----




# --- H-1: the sidecar rejects unauthenticated calls when a token is set -------




# --- M-4 (s3): a fully-denied bucket must report access_denied, not available -




# --- Ingestion row cap is reported, not silent (agent-native "no silent caps")


def test_access_log_ingest_cap_is_reported(tmp_path, monkeypatch):
    from app.analysis import access_logs

    monkeypatch.setattr(access_logs, "MAX_INGEST_ROWS", 3)
    log = tmp_path / "big.log"
    log.write_text("\n".join(f"line number {i}" for i in range(10)))
    imp = access_logs.import_access_logs(log, tmp_path / "a.duckdb", "text")
    assert imp["truncated"] is True and imp["ingest_cap"] == 3
    assert imp["row_count"] == 3

    small = tmp_path / "small.log"
    small.write_text("only one line")
    imp2 = access_logs.import_access_logs(small, tmp_path / "b.duckdb", "text")
    assert imp2["truncated"] is False


def test_inventory_ingest_cap_is_reported(tmp_path, monkeypatch):
    from app.analysis import inventory

    monkeypatch.setattr(inventory, "MAX_INGEST_ROWS", 2)
    csv = tmp_path / "inv.csv"
    csv.write_text("Key,Size\n" + "\n".join(f"k{i},{i * 10}" for i in range(6)))
    imp = inventory.import_inventory_file(csv, tmp_path / "inv.duckdb")
    assert imp["truncated"] is True and imp["ingest_cap"] == 2
    assert imp["row_count"] == 2


# --- A1: constrained aggregation — agent-chosen, whitelisted, no raw rows -----


_LOG_LINES = "\n".join(
    f'2026-06-25T10:0{i % 10}:00Z bucket-a GET /logs/f{i}.log {403 if i % 3 == 0 else 200} '
    f'{100 * (i + 1)} {10 + i} ms user-agent="ua-{i % 2}" remote_ip="192.0.2.{i}"'
    for i in range(9)
)


def _agg_db(tmp_path):
    from app.analysis import access_logs

    log = tmp_path / "a.log"
    log.write_text(_LOG_LINES)
    db = tmp_path / "a.duckdb"
    access_logs.import_access_logs(log, db, "text")
    return db


def test_aggregate_group_by_with_status_range(tmp_path):
    from app.analysis import aggregate

    out = aggregate.aggregate(_agg_db(tmp_path), "access_log", "count",
                              group_by="user_agent", status_min=400, status_max=499)
    assert out["group_by"] == "user_agent" and out["groups"]
    # 403s land on i % 3 == 0 → i in {0,3,6} → ua-0 twice (0,6), ua-1 once (3).
    got = {g["group"]: g["value"] for g in out["groups"]}
    assert got == {"ua-0": 2, "ua-1": 1}
    assert "?" in out["sql"] and len(out["params"]) == 2  # values are BOUND


def test_aggregate_scalar_and_equality_filter(tmp_path):
    from app.analysis import aggregate

    out = aggregate.aggregate(_agg_db(tmp_path), "access_log", "count",
                              filters={"method": "GET"})
    assert out["value"] == 9 and out["group_by"] is None
    assert out["params"] == ["GET"]  # bound, not interpolated


def test_aggregate_rejects_non_whitelisted_identifiers(tmp_path):
    from app.analysis import aggregate

    db = _agg_db(tmp_path)
    with pytest.raises(aggregate.AggregateError, match="Unknown group_by"):
        aggregate.aggregate(db, "access_log", "count", group_by="raw_sanitized; DROP TABLE x")
    with pytest.raises(aggregate.AggregateError, match="Unknown metric"):
        aggregate.aggregate(db, "access_log", "count(*)--")
    with pytest.raises(aggregate.AggregateError, match="Unknown filter column"):
        aggregate.aggregate(db, "access_log", "count", filters={"1=1": "x"})


def test_aggregate_filter_value_injection_is_inert(tmp_path):
    from app.analysis import aggregate

    db = _agg_db(tmp_path)
    # A hostile VALUE rides through as a bound parameter — matches nothing,
    # drops nothing.
    out = aggregate.aggregate(db, "access_log", "count",
                              filters={"method": "GET'; DROP TABLE access_logs; --"})
    assert out["value"] == 0
    out2 = aggregate.aggregate(db, "access_log", "count")
    assert out2["value"] == 9  # table intact


def test_aggregate_limit_reports_truncation(tmp_path):
    from app.analysis import aggregate

    out = aggregate.aggregate(_agg_db(tmp_path), "access_log", "count",
                              group_by="key", limit=3)
    assert len(out["groups"]) == 3 and out["truncated"] is True






# --- Codex P2: re-upload must not aggregate from the stale DuckDB table --------




# --- A4: active model provider selection --------------------------------------




# --- A5: user-message truncation is explicit, never silent --------------------




# --- A3/A6/A7: raised ceilings stay wired to their consumers ------------------




# --- B3: denylist no longer ossifies against a constrained aggregate tool -----




# --- B1: redaction precision — benign text must survive -----------------------


def test_redaction_precision_benign_text_untouched():
    from app.security.redaction import redact_text

    benign = (
        "The signature dish arrived; check the cookie jar. "
        "Bucket data-backups-prod-2026 has 40 characters exactly here: "
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN and a normal sentence."
    )
    assert redact_text(benign) == benign
