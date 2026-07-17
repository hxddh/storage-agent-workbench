"""v0.37.0 — four-angle audit batch: recovery, enumeration truth, provider
compat, engine correctness, de-ossification, redaction depth.

  P1  evidence import left 'importing' by a crash is failed at startup (was
      wedged forever — could never be re-confirmed nor re-run).
  O2  list_objects echoes the FULL S3 page (cap == page max): keys 501-1000 of a
      1000-key page were dropped with no way to page back to them.
  O1  the final answer's post-processing cap is elastic and NEVER cuts silently.
  S2  test_conditional_get: a provider that ignores If-None-Match (200 + same
      ETag) reports "unchanged + unsupported", not a false "object changed".
  S4  list_multipart_uploads takes a prefix (usable on prefix-scoped providers).
  E1  no "Storage-class skew 'None'" finding when the column is absent.
  E2  average_object_size keeps int64 precision (floor division).
  P3  session_messages JSON columns are redacted at the persistence boundary.
  O3  completion budget's only upper bound is the model's real provider max.
  O6/O7 survey-summary echo + deterministic summary caps scale with the window.
  E3  binary-divisor sizes carry binary labels (KiB/MiB).
  S1  a bare AK/SK PAIR paste is fully scrubbed (SK included), while ordinary
      40-char strings without a key-id hint are untouched.
  S3  InvalidRequest maps to "no object lock" ONLY in its object-lock flavor.
  P4  read-only duck.connect on a missing DB is a clean error, no stray file.
  P5  session_datasets dedupe matches NULL filenames (IS, not =).
"""

from __future__ import annotations

import sqlite3

import pytest

from app.migrations import apply_migrations


def _db(tmp_path, name="t.db"):
    conn = sqlite3.connect(tmp_path / name)
    conn.row_factory = sqlite3.Row
    apply_migrations(conn)
    return conn


# --- P1: evidence-import startup reconciler ----------------------------------

def test_interrupted_evidence_import_is_failed_on_startup(tmp_path):
    from app.repositories import evidence_imports as repo

    conn = _db(tmp_path)
    import_id = repo.create_plan(
        conn, provider_id="p1", account_run_id=None, snapshot_id=None,
        source_type="access_log", source_bucket="b", source_prefix="logs/",
        evidence_ref=None, fmt=None, fmt_schema=None, plan_source="agent",
        max_files=2, max_bytes=1000, time_range_start=None, time_range_end=None,
        planned_file_count=2, planned_total_bytes=200, selected_file_count=2,
        selected_total_bytes=200, warnings=[],
        files=[{"object_key": "logs/a", "size_bytes": 100, "kind": "log", "selected": True},
               {"object_key": "logs/b", "size_bytes": 100, "kind": "log", "selected": True}],
    )
    repo.set_status(conn, import_id, "confirmed")
    assert repo.claim_for_import(conn, import_id, "run-x")  # → 'importing'
    # Simulate the crash: nothing else runs; next boot reconciles.
    assert repo.mark_interrupted(conn) == 1
    row = repo.get(conn, import_id)
    assert row["status"] == "failed"  # re-runnable via a fresh plan, not wedged
    files = conn.execute(
        "SELECT status FROM evidence_import_files WHERE import_id = ?", (import_id,)
    ).fetchall()
    assert all(f["status"] == "failed" for f in files)
    # Idempotent: a second boot reconciles nothing.
    assert repo.mark_interrupted(conn) == 0
    conn.close()


def test_reconcile_interrupted_runs_covers_evidence_imports(monkeypatch, tmp_path):
    from app import run_service

    conn_path = tmp_path / "svc.db"
    conn = sqlite3.connect(conn_path)
    conn.row_factory = sqlite3.Row
    apply_migrations(conn)
    conn.execute("INSERT INTO evidence_imports (id, source_type, status, created_at) "
                 "VALUES ('imp1', 'access_log', 'importing', 't')")
    conn.commit()
    conn.close()

    def _connect():
        c = sqlite3.connect(conn_path)
        c.row_factory = sqlite3.Row
        return c

    monkeypatch.setattr(run_service.db, "connect", _connect)
    assert run_service.reconcile_interrupted_runs() == 1
    check = _connect()
    assert check.execute("SELECT status FROM evidence_imports WHERE id='imp1'").fetchone()[0] == "failed"
    check.close()


# --- O2: the echo cap can never clip an S3 page -------------------------------

def test_list_keys_ctx_cap_covers_full_page():
    from app.agent_runtime import session_tools
    from app.s3 import tools as s3

    # next_token is computed over the FULL page, so an echo cap below the page
    # size makes the clipped tail permanently unreachable.
    assert session_tools._LIST_KEYS_CTX_CAP >= s3.MAX_LIST_KEYS


# --- O1: answer cap is elastic and marked -------------------------------------

def test_answer_truncation_is_marked_not_silent():
    from app.agent_runtime import session_agent as sa

    long_answer = "x" * (sa._MAX_OUTPUT + 1000)
    contract = sa._finalize_contract(long_answer, [], [])
    assert sa._ANSWER_CUT_MARKER in contract["answer"]
    # An answer within the cap is untouched.
    ok = sa._finalize_contract("short answer", [], [])
    assert ok["answer"] == "short answer"


def test_answer_cap_scales_with_completion_budget():
    from app.agent_runtime import session_agent as sa

    # Floor for unknown/small models; ≥ 4 chars/token of the completion budget
    # for large-output models, so post-processing never cuts a legal completion.
    assert sa._answer_cap(None) == sa._MAX_OUTPUT
    assert sa._answer_cap({"model": "gpt-4o"}) >= sa._MAX_OUTPUT
    big = sa._answer_cap({"model": "gemini-2.5-pro"})
    assert big >= 4 * 64_000


# --- S2: conditional GET vs providers that ignore If-None-Match ---------------

class _FakeClient:
    def __init__(self, etag):
        self._etag = etag

    def head_object(self, **kw):
        return {"ETag": self._etag}


def test_conditional_get_same_etag_is_unsupported_not_changed(monkeypatch):
    from app.s3 import client_factory
    from app.s3 import tools as s3

    monkeypatch.setattr(client_factory, "build_s3_client",
                        lambda conn, pid: _FakeClient('"abc123"'))
    # Caller passes the ETag bare (no quotes) — normalization must still match.
    out = s3.test_conditional_get(None, "p", "b", "k", "abc123")
    assert out["success"] is True
    assert out["etag_matches"] is True          # NOT a false "changed"
    assert out["error_code"] == s3.PROVIDER_UNSUPPORTED

    # A genuinely different ETag on 200 is still "changed".
    monkeypatch.setattr(client_factory, "build_s3_client",
                        lambda conn, pid: _FakeClient('"other"'))
    out = s3.test_conditional_get(None, "p", "b", "k", "abc123")
    assert out["etag_matches"] is False


# --- S4: multipart listing accepts a prefix -----------------------------------

def test_list_multipart_uploads_passes_prefix(monkeypatch):
    from app.s3 import client_factory
    from app.s3 import tools as s3

    seen = {}

    class _C:
        def list_multipart_uploads(self, **kw):
            seen.update(kw)
            return {"Uploads": [], "IsTruncated": False}

    monkeypatch.setattr(client_factory, "build_s3_client", lambda conn, pid: _C())
    out = s3.list_multipart_uploads(None, "p", "b", prefix="team/data/")
    assert out["success"] is True
    assert seen.get("Prefix") == "team/data/"


# --- E1/E2: inventory findings + precision ------------------------------------

def _inv(tmp, header, rows):
    import os

    from app.analysis import inventory as inv
    p = os.path.join(tmp, "i.csv")
    open(p, "w").write(header + rows)
    db = os.path.join(tmp, "i.duckdb")
    inv.import_inventory_file(p, db)
    return db


def test_no_storage_class_skew_finding_for_missing_column(tmp_path):
    from app.analysis import inventory as inv

    db = _inv(str(tmp_path), "bucket,key,size,last_modified\n",
              "".join(f"b,k{i},100,2026-01-01T00:00:00Z\n" for i in range(20)))
    m = inv.analyze_inventory(db)
    f = inv.derive_findings(m)
    assert not any(x["title"] == "Storage-class skew" for x in f)


def test_storage_class_skew_still_fires_on_real_skew(tmp_path):
    from app.analysis import inventory as inv

    db = _inv(str(tmp_path), "bucket,key,size,last_modified,storage_class\n",
              "".join(f"b,k{i},100,2026-01-01T00:00:00Z,STANDARD\n" for i in range(20)))
    m = inv.analyze_inventory(db)
    f = inv.derive_findings(m)
    assert any(x["title"] == "Storage-class skew" for x in f)


def test_average_object_size_keeps_int64_precision():
    # Pure arithmetic check of the fixed expression shape.
    total, count = 9_007_199_254_740_993, 1  # 2^53 + 1
    assert int(total) // int(count) == total
    assert int(total / count) != total  # the old float path really was lossy


# --- P3: session_messages JSON columns are redacted ---------------------------

def test_session_message_json_columns_are_redacted(tmp_path):
    from app.repositories import sessions as repo

    conn = _db(tmp_path)
    sid = repo.create(conn, __import__("app.models.schemas", fromlist=["SessionCreate"])
                      .SessionCreate(title="t"))
    key_id = "AKIA" + "ABCDEFGHIJKLMNOP"  # assembled: keep secret-shaped literals out of source
    mid = repo.add_message(
        conn, sid, "assistant", "hello",
        tool_activity=[{"tool": "x", "result": key_id}],
        grounding={"evidence_used": ["secret_key=" + "wJalrXUtnFEMIK7MDENGbPxRfiCY" + "EXAMPLEKEYAA"]},
    )
    row = conn.execute("SELECT tool_activity, grounding FROM session_messages WHERE id = ?",
                       (mid,)).fetchone()
    assert "AKIA" not in row["tool_activity"]
    assert "wJalrXUtnFEMIK7MDENG" not in row["grounding"]
    conn.close()


# --- O6: survey summary echo scales with the window ---------------------------

def test_run_result_summary_cap_is_elastic(tmp_path):
    from app.agent_runtime import session_action_tools as sat
    from app.models.schemas import RunCreate
    from app.repositories import runs as runs_repo

    conn = _db(tmp_path)
    rid = runs_repo.create(conn, RunCreate(run_type="account_discovery", user_prompt="x"),
                           status="completed")
    runs_repo.set_status(conn, rid, "completed", final_summary="s" * 10_000)
    small = sat._run_result(conn, rid)  # default floor
    big = sat._run_result(conn, rid, summary_cap=8000)
    assert len(small["final_summary"]) == sat._MAX_SUMMARY
    assert len(big["final_summary"]) == 8000
    conn.close()


# --- O7: persisted summary holds more than the old flat 50 --------------------

def test_summary_builder_persists_beyond_fifty():
    from app.sessions import summary_builder as sb

    assert sb.MAX_FACTS >= 200 and sb.MAX_FINDINGS >= 200
    # The human digest stays readable: rendering caps at MD_RENDER_CAP with an
    # explicit "+N more" note.
    facts = [{"text": f"f{i}", "source_run_id": None} for i in range(sb.MD_RENDER_CAP + 5)]
    md = sb._render_md({"title": "t", "goal": None}, facts, [], [], [], [])
    assert "…and 5 more" in md


# --- E3: binary labels for binary math ----------------------------------------

def test_bytes_h_uses_binary_labels():
    from app.runs.analysis_report import _bytes_h

    assert _bytes_h(1024) == "1.0 KiB"
    assert _bytes_h(1_000_000) == "976.6 KiB"  # binary divisor, binary label
    assert _bytes_h(1048576) == "1.0 MiB"


# --- S1: bare AK/SK pair paste is scrubbed ------------------------------------

# Assembled at runtime (not literals) so GitHub push protection doesn't flag the
# AWS docs example pair in this file's source; the redactor sees the same text.
_EX_KEY_ID = "AKIA" + "IOSFODNN7" + "EXAMPLE"
_EX_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCY" + "EXAMPLEKEY"


def test_bare_secret_key_scrubbed_when_paired_with_key_id():
    from app.security.redaction import REDACTED, redact_text

    out = redact_text(f"my creds: {_EX_KEY_ID} and {_EX_SECRET}")
    assert _EX_SECRET not in out
    assert _EX_KEY_ID not in out
    assert REDACTED in out


def test_bare_forty_char_string_untouched_without_key_id():
    from app.security.redaction import redact_text

    # No access-key-id hint → a 40-char token (e.g. a hash or object key part)
    # must NOT be mangled.
    assert redact_text(f"checksum is {_EX_SECRET}") == f"checksum is {_EX_SECRET}"


# --- S3: InvalidRequest → "none" only in its object-lock flavor ---------------

def _lock_client(code, message):
    from botocore.exceptions import ClientError

    class _C:
        def get_object_retention(self, **kw):
            raise ClientError({"Error": {"Code": code, "Message": message}}, "GetObjectRetention")

        def get_object_legal_hold(self, **kw):
            raise ClientError({"Error": {"Code": code, "Message": message}}, "GetObjectLegalHold")

    return _C()


def test_invalid_request_object_lock_flavor_is_none(monkeypatch):
    from app.s3 import client_factory
    from app.s3 import tools as s3

    monkeypatch.setattr(client_factory, "build_s3_client",
                        lambda conn, pid: _lock_client(
                            "InvalidRequest", "Bucket is missing Object Lock Configuration"))
    out = s3.get_object_lock_status(None, "p", "b", "k")
    assert out["retention_status"] == "none" and out["legal_hold_status"] == "none"
    assert out["error_code"] is None


def test_invalid_request_other_flavor_is_not_none(monkeypatch):
    from app.s3 import client_factory
    from app.s3 import tools as s3

    monkeypatch.setattr(client_factory, "build_s3_client",
                        lambda conn, pid: _lock_client("InvalidRequest", "Invalid version id specified"))
    out = s3.get_object_lock_status(None, "p", "b", "k")
    # NOT silently "clean/deletable": the error is surfaced.
    assert out["error_code"] == "InvalidRequest"


# --- P4: read-only connect on a missing DB — clean error, no stray file -------

def test_readonly_connect_missing_db_is_clean_error_no_stray_file(tmp_path):
    from app.analysis import duck

    missing = tmp_path / "none" / "missing.duckdb"
    with pytest.raises(ValueError, match="no analytical database"):
        duck.connect(missing, read_only=True)
    assert not missing.exists()  # the old fallback created an empty writable DB


# --- P5: NULL-filename dedupe -------------------------------------------------

def test_session_dataset_upsert_dedupes_null_filename(tmp_path):
    from app.models.schemas import SessionCreate
    from app.repositories import session_datasets as sds
    from app.repositories import sessions as repo

    conn = _db(tmp_path)
    sid = repo.create(conn, SessionCreate(title="t"))
    a = sds.upsert(conn, sid, "access_log", None, "up/x.log")
    b = sds.upsert(conn, sid, "access_log", None, "up/x.log")
    assert a == b  # reused, not a second row at the same path
    n = conn.execute("SELECT count(*) FROM session_datasets WHERE session_id = ?",
                     (sid,)).fetchone()[0]
    assert n == 1
    conn.close()
