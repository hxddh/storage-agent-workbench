"""v0.40.0 — security redaction/scope, ingestion bounds, run-executor truth,
provider credential robustness.

Security (SEC):
  SEC3  prefix scope matches at a PATH boundary — allowed_prefixes=["logs"]
        denies "logs-private/secret" while allowing "logs/app.log"; an empty ""
        entry never widens scope.
  SEC1  Azure Blob SAS `sig=` HMAC is redacted (non-secret `se=`/`sp=` kept).
  SEC5  temporary-credential session tokens (FQoG/FwoG/IQoJ…) are redacted.
  SEC6  `private_key = <value>` secrets are redacted, label kept.

Ingestion (ING):
  ING1  _nonempty_lines reads bounded chunks — a single 50 MiB line can't be
        slurped whole into one Python str.
  ING3  free-text group-by labels are clipped to _LABEL_LEN in both the
        access-log and inventory analyzers.
  ING2  finding cells are HTML-escaped in both report writers (no raw <img>).
  ING4  a future-dated object lands in the 'unknown' age bucket, not '0-7d'.
  ING5  duck._configure applies the memory/threads pragmas without error.

Run executors (RUN):
  RUN1  recent_run_ids_for_provider returns only COMPLETED surveys (a partial /
        crashed run's snapshot is never read back as newest).
  RUN4  a region-mismatch (301/PermanentRedirect) HeadBucket surfaces the
        REGION_MISMATCH status constant.

Provider (PROV):
  PROV1 the vault .tmp is forced to 0600 before ciphertext is written.
  PROV2 a malformed credential ref becomes a CredentialResolutionError, not a
        raw ValueError 500.
  RUN6  a combine's cumulative decompressed output is bounded across all parts.
"""

from __future__ import annotations

import io
import os
import sqlite3

from app import config


# --- SEC3: prefix scope path-boundary matching -------------------------------

def test_scope_prefix_boundary_denies_sibling_path():
    from app.s3.scope import check_scope

    # "logs" must NOT admit "logs-private/..." (a different top-level path).
    assert check_scope(None, ["logs"], "b", key="logs-private/secret") is not None
    # but DOES admit the exact prefix and anything under it.
    assert check_scope(None, ["logs"], "b", key="logs/app.log") is None
    assert check_scope(None, ["logs"], "b", key="logs") is None
    # a trailing-slash prefix admits children.
    assert check_scope(None, ["logs/"], "b", key="logs/app.log") is None


def test_scope_empty_prefix_entry_does_not_widen():
    from app.s3.scope import check_scope

    # A stray "" must not turn into "match everything".
    assert check_scope(None, ["", "x"], "b", key="other/y") is not None
    assert check_scope(None, ["", "x"], "b", key="x/y") is None


# --- SEC1/5/6: redaction of non-AWS secrets ----------------------------------

def test_redact_azure_sas_signature():
    from app.security.redaction import redact_text

    url = ("https://acct.blob.core.windows.net/c/b?sp=r&st=2024-01-01T00:00:00Z"
           "&se=2024-12-31T00:00:00Z&sig=abcDEF123%2Fsecrethmac%3D")
    out = redact_text(url)
    assert "abcDEF123" not in out and "secrethmac" not in out
    # Non-secret SAS params stay (they carry no credential).
    assert "se=2024-12-31T00:00:00Z" in out


def test_redact_session_token():
    from app.security.redaction import redact_text

    tok = "FQoGZXIvYXdzEBragedyaddagedyaddaBLAHBLAHBLAH0123456789abcdefXYZ="
    out = redact_text(f"aws_session_token={tok}")
    assert "agedyaddagedy" not in out
    assert tok not in out


def test_redact_private_key_value():
    from app.security.redaction import redact_text

    out = redact_text("private_key = AKIAsecretMATERIALvalue0123456789abcd")
    assert "secretMATERIALvalue" not in out
    # The label survives so the log still says WHAT was redacted.
    assert "private_key" in out


# --- ING1: bounded line reads ------------------------------------------------

def test_nonempty_lines_bounds_a_giant_single_line(tmp_path):
    from app.analysis import access_logs

    p = tmp_path / "huge.log"
    # One 50 MiB line with no newline.
    p.write_bytes(b"a" * (50 * 1024 * 1024))
    lines = access_logs._nonempty_lines(p, limit=5)
    # Each returned chunk is bounded by _MAX_LINE_CHARS, never the whole 50 MiB.
    assert lines
    assert all(len(ln) <= access_logs._MAX_LINE_CHARS for ln in lines)


# --- ING3: clipped group-by labels -------------------------------------------

def test_clip_bounds_free_text_labels():
    from app.analysis import access_logs as al
    from app.analysis import inventory as inv

    long = "x" * 5000
    assert len(al._clip(long)) <= al._LABEL_LEN + 1  # +1 for the ellipsis
    assert len(inv._clip(long)) <= inv._LABEL_LEN + 1
    assert al._clip("short") == "short"


# --- ING2: HTML-escaped finding cells ----------------------------------------

def test_report_findings_are_html_escaped():
    from app.runs import analysis_report, report

    finding = {"severity": "high", "title": "<img src=x onerror=alert(1)>",
               "detail": "a & b < c"}
    md1 = analysis_report._findings_md([finding])
    assert "<img" not in md1 and "&lt;img" in md1
    esc = report._esc("<img src=x>")
    assert "<img" not in esc and "&lt;img" in esc


# --- ING4: future-dated object → 'unknown' age -------------------------------

def test_future_dated_object_is_unknown_age(tmp_path):
    import duckdb

    from app.analysis import inventory

    dbp = tmp_path / "inv.duckdb"
    con = duckdb.connect(str(dbp))
    con.execute(f"CREATE TABLE {inventory.TABLE_NAME} "
                "(key VARCHAR, prefix VARCHAR, size BIGINT, last_modified VARCHAR, "
                " storage_class VARCHAR)")
    con.execute(
        f"INSERT INTO {inventory.TABLE_NAME} VALUES "
        "('a', '', 10, '2999-01-01T00:00:00Z', 'STANDARD'), "
        "('b', '', 20, '2000-01-01T00:00:00Z', 'STANDARD')"
    )
    con.close()

    result = inventory.analyze_inventory(dbp)
    ages = {row["bucket"]: row["count"] for row in result["object_age_distribution"]}
    assert ages.get("unknown", 0) >= 1     # the 2999 object
    assert ages.get("0-7d", 0) == 0        # it must NOT be 'freshly modified'


# --- ING5: duck pragmas apply cleanly ----------------------------------------

def test_duck_configure_applies_pragmas(tmp_path):
    from app.analysis import duck

    con = duck.connect(tmp_path / "x.duckdb")
    try:
        # memory_limit was set (best-effort); it should read back non-null.
        val = con.execute("SELECT current_setting('memory_limit')").fetchone()[0]
        assert val  # some human string like '1.8 GiB'
    finally:
        con.close()


# --- RUN1: only completed surveys are read back ------------------------------

def _insert_run(conn: sqlite3.Connection, run_id: str, provider_id: str,
                status: str, created: str) -> None:
    conn.execute(
        "INSERT INTO runs "
        "(id, run_type, title, status, provider_id, bucket, prefix, "
        " user_prompt, final_summary, report_path, options_json, session_id, "
        " origin, created_at, updated_at) "
        "VALUES (?, 'account_discovery', 't', ?, ?, NULL, NULL, NULL, NULL, "
        " NULL, NULL, NULL, 'agent', ?, ?)",
        (run_id, status, provider_id, created, created),
    )
    conn.commit()


def test_recent_run_ids_excludes_partial_survey(client):
    from app.repositories import account_discovery as ad

    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    pid = "prov-x"

    # Older COMPLETED survey.
    _insert_run(conn, "run-done", pid, "completed", "2026-01-01T00:00:00Z")
    ad.create_snapshot(conn, "run-done", pid, bucket_count=3, visible_count=3,
                       processed_count=3, truncated=False, list_status="ok",
                       summary={})
    # NEWER run that crashed mid-survey (status still 'running').
    _insert_run(conn, "run-partial", pid, "running", "2026-02-01T00:00:00Z")
    ad.create_snapshot(conn, "run-partial", pid, bucket_count=3, visible_count=3,
                       processed_count=3, truncated=False, list_status="ok",
                       summary={})

    ids = ad.recent_run_ids_for_provider(conn, pid, limit=2)
    assert ids == ["run-done"]  # the newer partial is excluded
    conn.close()


# --- RUN4: region-mismatch status constant -----------------------------------

def test_region_mismatch_constant_exists():
    from app.s3 import account_tools

    assert account_tools.REGION_MISMATCH == "region_mismatch"


# --- PROV1: vault tmp is 0600 ------------------------------------------------

def test_vault_tmp_is_mode_0600(tmp_path, monkeypatch):
    monkeypatch.setenv("SAW_DATA_DIR", str(tmp_path / "vault"))
    from app.security import keyring_store

    keyring_store._reset_for_tests()
    keyring_store.save_secret("scope", "name", "supersecretvalue")
    vault = keyring_store._vault_path()
    assert vault.exists()
    mode = os.stat(vault).st_mode & 0o777
    assert mode == 0o600, oct(mode)


# --- PROV2: malformed ref → CredentialResolutionError ------------------------

def test_malformed_ref_raises_credential_error():
    from app.s3 import client_factory

    try:
        client_factory._resolve("not-a-keyring-ref")
    except client_factory.CredentialResolutionError:
        pass
    else:
        raise AssertionError("expected CredentialResolutionError")
    # empty/None refs still resolve to None (no credentials configured).
    assert client_factory._resolve(None) is None
    assert client_factory._resolve("") is None


# --- RUN6: cumulative decompression budget -----------------------------------

def test_combine_cumulative_output_budget():
    from app.evidence import managed_import as m

    b = m._OutBudget(cap=100)
    b.take(60)
    try:
        b.take(60)  # 120 > 100
    except m.LimitExceeded:
        pass
    else:
        raise AssertionError("expected LimitExceeded on cumulative overflow")


def test_append_maybe_gunzip_copy_path_honors_budget(tmp_path):
    from app.evidence import managed_import as m

    part = tmp_path / "part_00000"
    part.write_bytes(b"x" * 200)  # plain (non-gzip) content
    out = io.BytesIO()
    budget = m._OutBudget(cap=100)
    try:
        m._append_maybe_gunzip(part, out, budget)
    except m.LimitExceeded:
        pass
    else:
        raise AssertionError("expected LimitExceeded from cumulative budget")
    # Back-compat: no budget → unbounded copy still works.
    out2 = io.BytesIO()
    m._append_maybe_gunzip(part, out2)
    assert out2.getvalue() == b"x" * 200
