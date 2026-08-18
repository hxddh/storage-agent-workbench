"""The agent can ask a follow-up question of evidence it already imported.

Before this, the two dataset stores were reachable asymmetrically. A file the
user dragged into the chat could be aggregated freely (whitelisted metric +
group-by + filters, ``aggregate_uploaded_file``); access logs the session had
just *downloaded from the bucket* — after a confirmed, expensive import — could
only be read back through the run's fixed ``final_summary``. The follow-up
"which masked IP got the most 403s?" was answerable for the cheap source and
not for the expensive one.

These tests pin the new path and, just as importantly, its boundaries: session
scoping, the unchanged whitelist, and the truncation caveat carrying over
(the run importer did not persist it — this surface would otherwise have
reproduced the v0.80.0 defect on day one).
"""
import json
import sqlite3

import pytest

from app import config, db
from app.analysis import access_logs
from tests.test_analysis import ACCESS_LOG_TEXT, _run_analysis, sync_runs  # noqa: F401

# Text format on purpose: the detector picks ONE format per file, so a mixed
# jsonl+text sample would import only the single JSON line. Four rows across
# three status codes is what makes the group-by assertions meaningful.
_LOG = ACCESS_LOG_TEXT


def _db():
    c = db.serialized(sqlite3.connect(str(config.db_path())))
    c.row_factory = sqlite3.Row
    return c


class _FT:
    def __call__(self, fn):
        fn.name = fn.__name__
        return fn


def _tools(conn, session_id):
    from app.agent_runtime import session_analysis_tools
    return {t.name: t for t in session_analysis_tools.build(conn, _FT(), session_id)}


def _session_with_import(client, conn, log=_LOG):
    """Import access logs through a run, then link that run to a fresh session."""
    from app.repositories import sessions as sessions_repo

    run_id = _run_analysis(client, "access_log_analysis", "access_log",
                           "access.jsonl", log, "analyze logs")
    assert client.get(f"/runs/{run_id}").json()["status"] == "completed"
    ses = client.post("/sessions", json={"title": "t", "goal": "g"}).json()["id"]
    sessions_repo.link_run(conn, ses, run_id, "access_log_analysis")
    conn.commit()
    return ses, run_id


def test_imported_evidence_is_discoverable_and_queryable(client, sync_runs):  # noqa: F811
    conn = _db()
    try:
        ses, run_id = _session_with_import(client, conn)
        tools = _tools(conn, ses)

        listed = json.loads(tools["list_imported_evidence"]())["datasets"]
        assert len(listed) == 1
        assert listed[0]["type"] == "access_log"
        assert listed[0]["run_id"] == run_id
        assert listed[0]["covers_whole_source"] is True

        out = json.loads(tools["aggregate_imported_evidence"](
            listed[0]["dataset_id"], "count", "status_code"))
        # The question the run's fixed summary could not answer.
        assert {g["group"] for g in out["groups"]} == {"206", "403", "404"}
        assert next(g["value"] for g in out["groups"] if g["group"] == "206") == 2
        assert out["run_id"] == run_id
    finally:
        conn.close()


def test_another_sessions_evidence_is_neither_listed_nor_queryable(client, sync_runs):  # noqa: F811
    """Scoping is the security story: reachability runs through a run THIS
    session owns, so knowing a dataset_id is not enough."""
    conn = _db()
    try:
        ses_a, _ = _session_with_import(client, conn)
        other_id = json.loads(_tools(conn, ses_a)["list_imported_evidence"]()
                              )["datasets"][0]["dataset_id"]

        ses_b = client.post("/sessions", json={"title": "b", "goal": "g"}).json()["id"]
        tools_b = _tools(conn, ses_b)
        assert json.loads(tools_b["list_imported_evidence"]())["datasets"] == []
        denied = json.loads(tools_b["aggregate_imported_evidence"](other_id, "count"))
        assert "error" in denied and "this session" in denied["error"]
    finally:
        conn.close()


@pytest.mark.parametrize("metric,group_by,needle", [
    ("rm -rf", "", "metric"),
    ("count", "secret_column", "group"),
    ("count; DROP TABLE access_logs", "", "metric"),
])
def test_whitelist_is_unchanged_on_the_new_surface(client, sync_runs, metric, group_by, needle):  # noqa: F811
    """The new tool is a second door to the same engine, not a looser one."""
    conn = _db()
    try:
        ses, _ = _session_with_import(client, conn)
        tools = _tools(conn, ses)
        did = json.loads(tools["list_imported_evidence"]())["datasets"][0]["dataset_id"]
        out = json.loads(tools["aggregate_imported_evidence"](did, metric, group_by))
        assert "error" in out and needle in out["error"].lower()
    finally:
        conn.close()


def test_truncated_import_says_the_answer_covers_part_of_the_file(
    client, sync_runs, monkeypatch  # noqa: F811
):
    """The run importer did not persist truncation, so this surface would have
    served capped data with no caveat — the v0.80.0 defect, reproduced."""
    monkeypatch.setattr(access_logs, "MAX_INGEST_ROWS", 2)  # of the file's 4 rows
    conn = _db()
    try:
        ses, _ = _session_with_import(client, conn)
        tools = _tools(conn, ses)
        listed = json.loads(tools["list_imported_evidence"]())["datasets"][0]
        assert listed["covers_whole_source"] is False

        out = json.loads(tools["aggregate_imported_evidence"](
            listed["dataset_id"], "count", "status_code"))
        assert out["source_truncated"] is True
        assert out["rows_analyzed"] == 2
        assert "ingest cap" in out["note"]
        # count only grows with more rows — say which way the number is wrong.
        assert "LOWER BOUND" in out["note"] or "lower bound" in out["note"].lower()
    finally:
        conn.close()


def test_pre_migration_row_reports_unknown_not_complete(client, sync_runs):  # noqa: F811
    """A dataset imported before the columns existed has truncated = NULL. A run
    dataset is never re-imported, so that NULL never self-corrects — it must be
    reported as UNKNOWN rather than rendered as "covers the whole file"."""
    conn = _db()
    try:
        ses, _ = _session_with_import(client, conn)
        tools = _tools(conn, ses)
        did = json.loads(tools["list_imported_evidence"]())["datasets"][0]["dataset_id"]
        # Simulate the pre-upgrade row.
        conn.execute("UPDATE datasets SET truncated=NULL, ingest_cap=NULL WHERE id=?", (did,))
        conn.commit()

        listed = json.loads(tools["list_imported_evidence"]())["datasets"][0]
        assert listed["covers_whole_source"] is None

        out = json.loads(tools["aggregate_imported_evidence"](did, "count"))
        assert "UNKNOWN" in out["note"]
        assert out.get("source_truncated") is None
    finally:
        conn.close()


def test_the_real_sql_lands_in_the_audit_log(client, sync_runs):  # noqa: F811
    """Rule 17 — and the run_id, so an aggregate is traceable to the import that
    produced the data."""
    conn = _db()
    try:
        ses, run_id = _session_with_import(client, conn)
        tools = _tools(conn, ses)
        did = json.loads(tools["list_imported_evidence"]())["datasets"][0]["dataset_id"]
        tools["aggregate_imported_evidence"](did, "count", "status_code")

        row = conn.execute(
            "SELECT payload_json_sanitized AS p, run_id FROM audit_logs "
            "WHERE event_type='session.aggregate_imported_evidence' ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
        assert row is not None and row["run_id"] == run_id
        payload = json.loads(row["p"])
        assert "SELECT" in payload["sql"].upper()
        assert "access_logs" in payload["sql"]
    finally:
        conn.close()
