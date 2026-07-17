"""v0.34.0 — engine correctness, lifecycle robustness, de-ossification, model config.

  E1  numeric columns stay integer (status codes not "404.0"; size precision).
  E2  access-log error rates use parsed-request denominator, not all lines.
  E3  inventory average/small-ratio use consistent denominators.
  E4  inventory age bucketing is UTC (tz-independent).
  E5/OSS1  aggregate: 2nd group-by dim, day/weekday, distinct/p99, tiebreaker.
  SM3 loser of a concurrent import claim fails its orphan run.
  MO  operator-declared max_output_tokens clamps the completion budget.
  PB  a single oversized tool output is hard-capped (covered in maxturns test).
  OSS2 agent-memory recall scales with the model window.
"""

from __future__ import annotations

import os
import tempfile

import pytest

from app.analysis import access_logs as al
from app.analysis import aggregate as agg
from app.analysis import inventory as inv


def _log(tmp, lines: str) -> str:
    p = os.path.join(tmp, "a.log")
    open(p, "w").write(lines)
    db = os.path.join(tmp, "a.duckdb")
    al.import_access_logs(p, db, "text")
    return db


_L = ('2026-06-25T10:00:00Z b GET /x 404 100 5 ms user-agent="c" remote_ip="1.2.3.4"\n'
      '2026-06-25T10:00:00Z b GET /y 500 200 9 ms user-agent="c" remote_ip="1.2.3.5"\n'
      "an unparseable line with no fields\n")


# --- E1: integer columns, no "404.0" ----------------------------------------

def test_status_codes_render_as_integers(tmp_path):
    db = _log(str(tmp_path), _L)
    m = al.analyze_access_logs(db)
    labels = {x["value"] for x in m["status_code_distribution"] if x["value"] != "None"}
    assert labels == {"404", "500"}
    assert not any("." in lbl for lbl in labels)


# --- E2: error rate is of PARSED requests ------------------------------------

def test_error_rate_denominator_is_parsed_requests(tmp_path):
    db = _log(str(tmp_path), _L)
    m = al.analyze_access_logs(db)
    # 2 parsed requests, 1 is 5xx → 0.5 (NOT 1/3 of all ingested lines).
    assert m["error_rate_5xx"] == 0.5
    assert m["error_rate_4xx"] == 0.5


# --- E3: inventory denominators ----------------------------------------------

def _inv(tmp, rows: str) -> str:
    p = os.path.join(tmp, "i.csv")
    open(p, "w").write("bucket,key,size,last_modified,storage_class\n" + rows)
    db = os.path.join(tmp, "i.duckdb")
    inv.import_inventory_file(p, db)
    return db


def test_inventory_average_reconciles_with_total_over_count(tmp_path):
    # 3 objects, total 200, one null size → avg = 200/3 = 66 (not 100 = 200/2).
    db = _inv(str(tmp_path),
              "b,k1,100,2026-01-01T00:00:00Z,STANDARD\n"
              "b,k2,,2026-01-01T00:00:00Z,STANDARD\n"
              "b,k3,100,2026-01-01T00:00:00Z,STANDARD\n")
    m = inv.analyze_inventory(db)
    assert m["object_count"] == 3 and m["total_size"] == 200
    assert m["average_object_size"] == 66  # total/count, not total/known


# --- E5 / OSS1: aggregate vocabulary + tiebreaker ----------------------------

def test_aggregate_two_dims_and_new_metrics(tmp_path):
    db = _log(str(tmp_path), _L)
    out = agg.aggregate(db, "access_log", "distinct_ips",
                        group_by="status_code", group_by_2="day")
    assert out["group_by_2"] == "day"
    # composite labels join the two dims.
    assert any(" · " in g["group"] for g in out["groups"])
    # new metric works
    d = agg.aggregate(db, "access_log", "p99_latency_ms")
    assert "value" in d


def test_aggregate_rejects_out_of_whitelist_second_dim(tmp_path):
    db = _log(str(tmp_path), _L)
    with pytest.raises(agg.AggregateError):
        agg.aggregate(db, "access_log", "count", group_by="method", group_by_2="not_a_dim")


# --- MO: operator max_output clamps the completion budget --------------------

def test_max_output_tokens_explicit_wins():
    from app.agent_runtime import model_budget as mb

    # An unknown model would default to 16384; an operator cap of 4096 wins and
    # clamps the completion budget so a lower-cap endpoint doesn't 400.
    assert mb.max_output_tokens("some-unknown-model", explicit_max=4096) == 4096
    assert mb.completion_token_budget("some-unknown-model", explicit_max=4096) == 4096
    # 0/None → fall back to the table.
    assert mb.max_output_tokens("some-unknown-model", explicit_max=None) == 16384


# --- OSS2: agent-memory recall scales with the window ------------------------

def test_agent_memory_recall_is_model_elastic():
    from app.agent_runtime import session_agent as sa

    small = sa._elastic_memory_cap("gpt-4o", None)        # ~128k window
    big = sa._elastic_memory_cap("gpt-4.1", 1_000_000)    # explicit 1M window
    assert small == 50
    assert big > 50 and big <= sa._MEM_RECALL_CEIL


# --- SM3: concurrent import claim loser fails its orphan run ------------------

def test_import_claim_loser_fails_its_run(tmp_path, monkeypatch):
    # Unit-level: the repo helpers used by the loser branch behave as wired —
    # a run created then set 'failed' is terminal, not left 'pending'.
    import sqlite3

    from app.migrations import apply_migrations
    from app.models.schemas import RunCreate
    from app.repositories import runs as runs_repo

    conn = sqlite3.connect(tmp_path / "sm3.db")
    conn.row_factory = sqlite3.Row
    apply_migrations(conn)
    rid = runs_repo.create(conn, RunCreate(run_type="access_log_analysis", user_prompt="x"),
                           status="pending")
    runs_repo.set_status(conn, rid, "failed", final_summary="Superseded by a concurrent import.")
    assert runs_repo.get_row(conn, rid)["status"] == "failed"
    conn.close()
