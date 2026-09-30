"""v10 — survey output for a small window, and backend fixes found in review.

Pins: the survey's key facts come first (issue kinds with the rule's title and
severity, estate changes, coverage) and never get cut; bucket rows are columnar
without null or shared values and are what shrinks to fit; a review that
decides exposure updates every exposure field of the recorded posture; a
refusal's tool-row note is the same tidy clause as any other; the report emits
no empty conclusion section.
"""

from __future__ import annotations

import json

from app.agent import tools as _tools  # noqa: F401
from app.agent.recorder import Recorder
from app.agent.tools import account as account_tools
from app.agent.tools import registry
from app.core import store
from app.estate import store as estate


def _profile(n: int) -> dict:
    buckets = []
    for i in range(n):
        buckets.append({
            "bucket_name": f"team-{i:03d}-assets", "region": "eu-west-1" if i % 7 else "us-east-1",
            "access_status": "access_denied" if i % 11 == 5 else "available",
            "publicly_exposed": True if i % 13 == 0 else (None if i % 11 == 5 else False),
            "policy_is_public": i % 13 == 0,
            "encryption_status": "not_configured" if i % 3 == 0 else "available",
            "public_access_block_status": "not_configured" if i % 4 == 0 else "available",
            "lifecycle_status": "not_configured" if i % 2 else "available",
            "versioning_status": "available" if i % 5 else "not_configured",
            "logging_status": "not_configured", "inventory_status": "not_configured",
            "replication_status": "not_configured", "tagging_status": "not_configured",
            "evidence_sources": [{"source_type": "server_access_logging", "status": "available"}] if i % 9 == 0 else [],
        })
    return {"success": True, "visible": n, "processed": n, "truncated": False, "whole_account": True,
            "summary": {"public_bucket_count": sum(1 for b in buckets if b["publicly_exposed"]),
                        "exposure_unknown_count": sum(1 for b in buckets if b["publicly_exposed"] is None)},
            "summary_text": "…", "buckets": buckets}


def test_survey_key_facts_come_first_and_rows_are_columnar():
    out = account_tools._compact(_profile(23), "en", estate_changes={"opened": 4, "recurred": 0, "resolved": 1})
    assert list(out) == ["success", "issues", "estate_changes", "coverage", "buckets"]
    assert out["estate_changes"] == {"opened": 4, "resolved": 1}
    assert out["coverage"] == {"visible": 23, "surveyed": 23, "whole_account": True, "unreadable": 2,
                               "exposure_unknown": 2}
    public = out["issues"][0]
    assert public == {"code": "public_exposure", "title": "Bucket is publicly accessible", "severity": "high",
                      "buckets": 2, "names": ["team-000-assets", "team-013-assets"]}
    assert all(set(i) >= {"code", "title", "severity", "buckets"} for i in out["issues"])
    table = out["buckets"]
    assert table["columns"][0] == "bucket" and len(table["rows"]) == 23
    # Shared values are stated once; a field nobody has is not a column.
    assert table["common"]["logging_status"] == "not_configured" and "logging_status" not in table["columns"]
    assert "replication_status" not in json.dumps(out)
    # Most severe rows first.
    assert table["rows"][0][0] == "team-000-assets"
    # The duplicated counters and the repeated bucket-name lists are gone.
    text = json.dumps(out)
    assert "summary_text" not in text and "buckets_needing_review" not in text and "public_bucket_count" not in text


def test_rows_not_facts_are_cut_to_fit_a_small_window():
    profile = _profile(60)
    whole = account_tools._compact(profile, "en", estate_changes={"opened": 60})
    small = account_tools._compact(profile, "en", estate_changes={"opened": 60}, max_chars=4_000)
    assert len(registry.compact_json(small)) <= 4_000 - 200
    assert small["issues"] == whole["issues"] and small["coverage"] == whole["coverage"]
    assert small["estate_changes"] == {"opened": 60}
    kept = len(small["buckets"]["rows"])
    assert 0 < kept < 60 and small["buckets"]["rows_omitted"] == 60 - kept
    assert "query_estate" in small["buckets"]["note"]
    assert small["buckets"]["rows"] == whole["buckets"]["rows"][:kept]  # the most severe kept


def test_survey_output_is_a_fraction_of_the_v9_shape():
    """v9 sent summary + summary_text + ten fields per row: 23 uniform moto buckets
    were 11 487 chars and 60 were 27 426. v10 measured 1 715 and 3 039."""
    for n, v9 in ((23, 11_487), (60, 27_426)):
        size = len(registry.compact_json(account_tools._compact(_profile(n), "en", estate_changes={"opened": 1})))
        assert size < v9 * 0.5, (n, size)


def test_a_failed_survey_keeps_its_error():
    out = account_tools._compact({"success": False, "list_status": "access_denied", "error_code": "AccessDenied",
                                  "summary_text": "ListBuckets access_denied"}, "en")
    assert out["success"] is False and out["error_code"] == "AccessDenied"
    assert account_tools._survey_summary(out) == "AccessDenied"


# --- the recorded posture follows a review's exposure verdict ------------------------------------


def _mem(conn) -> None:
    conn.execute("INSERT INTO cloud_providers (id, name, provider_type, created_at, updated_at) "
                 "VALUES ('p1', 'prod', 's3', 'x', 'x')")
    conn.commit()


def _posture(conn, bucket: str) -> dict:
    row = conn.execute("SELECT posture FROM estate_buckets WHERE provider_id='p1' AND bucket=?", (bucket,)).fetchone()
    return store.loads(row["posture"], {})


def _security(*titles: str) -> dict:
    return {"security": {"success": True, "findings": [{"category": "critical", "title": t} for t in titles]}}


def test_a_review_that_finds_no_exposure_clears_every_exposure_field(conn):
    _mem(conn)
    estate.ingest_survey(conn, "p1", {"buckets": [{"bucket_name": "www", "publicly_exposed": True,
                                                   "policy_is_public": True, "acl_public": True}]})
    estate.ingest_review(conn, "p1", "www", _security())
    p = _posture(conn, "www")
    assert (p["publicly_exposed"], p["policy_is_public"], p["acl_public"]) == (False, False, False)


def test_a_review_that_finds_exposure_records_it(conn):
    _mem(conn)
    estate.ingest_survey(conn, "p1", {"buckets": [{"bucket_name": "www", "publicly_exposed": False}]})
    estate.ingest_review(conn, "p1", "www", _security("Anonymous s3:GetObject allowed"))
    assert _posture(conn, "www")["publicly_exposed"] is True


# --- a refusal's note ------------------------------------------------------------------------------


def test_a_refusal_note_is_a_tidy_short_clause(conn):
    task = store.create_task(conn, "t")
    turn = store.create_turn(conn, task["id"], "d")
    rec = Recorder(task["id"], turn["id"])
    try:
        rec.tool_refused("c1", "review_bucket_config", {"bucket": "x"},
                         "Bucket 'x' is outside this provider's allowed buckets (bucket(s) allowed: a, b, c); "
                         "ask the user to widen the scope in Settings.")
    finally:
        rec.close()
    out = next(i for i in store.items_for_turns(conn, [turn["id"]]) if i["type"] == "tool_output")["payload"]
    assert len(out["summary"]) <= registry.SUMMARY_CHARS and "(s)" not in out["summary"]
    assert out["model_output"].startswith("Refused: Bucket 'x'")  # the model still reads the whole reason


# --- the report ------------------------------------------------------------------------------------


def test_the_report_has_no_empty_conclusion_section(conn):
    from app.reports import report

    task = store.create_task(conn, "v9 task")
    turn = store.create_turn(conn, task["id"], "Check", status="completed")
    store.append_item(conn, task["id"], turn["id"], "user_message", {"text": "Check"})
    store.append_item(conn, task["id"], turn["id"], "conclusion", {
        "call_id": "c", "answer": "   ", "findings": [{"title": "No default encryption", "severity": "medium"}],
        "next_steps": []})
    store.append_item(conn, task["id"], turn["id"], "agent_message", {"text": "Encryption is off."})
    md = report.render(conn, task["id"])
    assert "## Conclusion" not in md and "**MEDIUM** — No default encryption" in md
