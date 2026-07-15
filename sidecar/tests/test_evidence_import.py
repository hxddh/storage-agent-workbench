"""Tests for Phase 15 managed evidence import.

A fake S3 client stands in for boto3 (no live cloud, no credentials). The
account profile (Phase 14 output) is seeded directly so the tests focus on the
managed-import flow: plan -> confirm -> run. They verify bounded listing of the
discovered destination ONLY, confirmation gating, max_files/max_bytes,
time-range requirement, download of confirmed evidence files only, reuse of the
existing inventory_analysis / access_log_analysis path, approval+audit logging,
secret-free reports, and that no business bucket is ever scanned or downloaded.
"""

import datetime as _dt
import gzip
import io
import json
import sqlite3

import pytest
from botocore.exceptions import ClientError

from app import config, run_service
from app.models.schemas import RunCreate
from app.repositories import account_discovery as account_repo
from app.repositories import runs as runs_repo
from app.s3 import client_factory

ACCESS = "AKIAIOSFODNN7EXAMPLE"
BEARER = "Bearer sk-LEAK-TOKEN-123"

INV_DEST = "inv-dest"
LOG_DEST = "log-bucket"
BUSINESS = "data-bucket"  # must NEVER be listed/downloaded by evidence import


def _cerr(code: str, http: int = 400) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "msg"}, "ResponseMetadata": {"HTTPStatusCode": http}}, "Op")


class FakeS3:
    """Read-only fake serving the evidence destinations only."""

    def __init__(self, objects=None, blobs=None):
        # objects: {bucket: [{"Key","Size","LastModified"}]}
        self.objects = objects or {}
        self.blobs = blobs or {}  # {(bucket,key): bytes}
        self.calls: list[tuple] = []

    def list_objects_v2(self, Bucket=None, Prefix="", MaxKeys=1000, ContinuationToken=None, **kw):
        self.calls.append(("list", Bucket, Prefix))
        items = [o for o in self.objects.get(Bucket, []) if str(o["Key"]).startswith(Prefix or "")]
        return {"Contents": items[:MaxKeys], "IsTruncated": False}

    def get_object(self, Bucket=None, Key=None, **kw):
        self.calls.append(("get", Bucket, Key))
        data = self.blobs.get((Bucket, Key))
        if data is None:
            raise _cerr("NoSuchKey", 404)
        return {"Body": io.BytesIO(data)}


def _use(monkeypatch, fake):
    monkeypatch.setattr(client_factory, "build_s3_client", lambda *a, **k: fake)


@pytest.fixture()
def sync_runs(monkeypatch):
    monkeypatch.setattr(run_service, "start", run_service.run_sync)


def _db():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


def _provider(client):
    return client.post("/cloud-providers", json={
        "name": "demo", "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
        "region": "us-east-1", "addressing_style": "path", "access_key": ACCESS, "secret_key": "shh",
    }).json()["id"]


def _seed_profile(provider_id, *, inventory=True, logging=True, inv_format="CSV"):
    conn = _db()
    try:
        run_id = runs_repo.create(
            conn, RunCreate(run_type="account_discovery", provider_id=provider_id, user_prompt="x"),
            status="completed")
        sid = account_repo.create_snapshot(
            conn, run_id, provider_id, bucket_count=1, visible_count=1, processed_count=1,
            truncated=False, list_status="available", summary={})
        account_repo.add_bucket(conn, sid, run_id, provider_id, BUSINESS, "us-west-2", "available")
        account_repo.add_config_snapshot(conn, sid, run_id, provider_id, BUSINESS,
                                         {"encryption_status": "available"})
        if inventory:
            account_repo.add_evidence_source(conn, sid, run_id, provider_id, BUSINESS, {
                "source_type": "inventory", "status": "available", "configured": True,
                "configurations": [{"inventory_id": "inv1", "destination_bucket": INV_DEST,
                                    "destination_prefix": "inv/", "format": inv_format}]})
        if logging:
            account_repo.add_evidence_source(conn, sid, run_id, provider_id, BUSINESS, {
                "source_type": "server_access_logging", "status": "available", "configured": True,
                "target_bucket": LOG_DEST, "target_prefix": "access/"})
        conn.commit()
        return run_id
    finally:
        conn.close()


def _gz(text: str) -> bytes:
    return gzip.compress(text.encode("utf-8"))


def _dtm(s: str) -> _dt.datetime:
    return _dt.datetime.fromisoformat(s)


# --- inventory: manifest + data files (CSV.gz, headerless) ------------------

_INV_MANIFEST_KEY = "inv/2026-01-01/manifest.json"
_INV_DATA_KEY = "inv/2026-01-01/data/file1.csv.gz"
_INV_CSV = (
    "data-bucket,datasets/train/p1.parquet,536870912,2026-01-01T00:00:00Z,STANDARD\n"
    "data-bucket,logs/app.log,2048,2026-01-02T00:00:00Z,STANDARD_IA\n"
    "data-bucket,tmp/small.txt,512,2026-01-03T00:00:00Z,STANDARD\n"
)


def _inventory_fake(extra_files=None, data_size=4096):
    data_blob = _gz(_INV_CSV)
    files = [{"key": _INV_DATA_KEY, "size": data_size}]
    if extra_files:
        files.extend(extra_files)
    manifest = {
        "sourceBucket": BUSINESS, "destinationBucket": f"arn:aws:s3:::{INV_DEST}",
        "fileFormat": "CSV",
        "fileSchema": "Bucket, Key, Size, LastModifiedDate, StorageClass",
        "files": files,
    }
    objects = {INV_DEST: [
        {"Key": _INV_MANIFEST_KEY, "Size": 200, "LastModified": _dtm("2026-01-01T01:00:00")},
        {"Key": _INV_DATA_KEY, "Size": data_size, "LastModified": _dtm("2026-01-01T01:00:00")},
    ]}
    blobs = {
        (INV_DEST, _INV_MANIFEST_KEY): json.dumps(manifest).encode(),
        (INV_DEST, _INV_DATA_KEY): data_blob,
    }
    return FakeS3(objects, blobs)


def _plan(client, run_id, source_type, **body):
    return client.post("/evidence-imports/plan", json={
        "account_run_id": run_id, "bucket_name": BUSINESS, "source_type": source_type, **body})


# --- inventory plan tests ---------------------------------------------------


def test_inventory_plan_from_manifest_success(client, monkeypatch):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    _use(monkeypatch, _inventory_fake())
    r = _plan(client, run_id, "inventory")
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["plan_source"] == "manifest"
    assert p["format"] == "csv"
    assert p["selected_file_count"] == 1
    assert p["status"] == "planned"
    # the data file is selected, the manifest itself is not a data file
    assert any(f["object_key"].endswith("file1.csv.gz") and f["selected"] for f in p["files"])


def test_inventory_plan_no_manifest_clean_limitation(client, monkeypatch):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    _use(monkeypatch, FakeS3({INV_DEST: []}))  # nothing under the prefix
    r = _plan(client, run_id, "inventory")
    assert r.status_code == 201
    p = r.json()
    assert p["selected_file_count"] == 0
    assert p["warnings"]  # clean limitation, not a crash
    # confirm must refuse a zero-file plan
    c = client.post(f"/evidence-imports/{p['id']}/confirm")
    assert c.status_code == 422


def test_inventory_plan_orc_detected_but_not_supported(client, monkeypatch):
    pid = _provider(client)
    run_id = _seed_profile(pid, inv_format="ORC")
    manifest = {"fileFormat": "ORC", "fileSchema": "Bucket, Key", "files": [{"key": "inv/x.orc", "size": 10}]}
    fake = FakeS3({INV_DEST: [{"Key": _INV_MANIFEST_KEY, "Size": 100, "LastModified": _dtm("2026-01-01T01:00:00")}]},
                  {(INV_DEST, _INV_MANIFEST_KEY): json.dumps(manifest).encode()})
    _use(monkeypatch, fake)
    r = _plan(client, run_id, "inventory")
    assert r.status_code == 201
    p = r.json()
    assert p["selected_file_count"] == 0
    assert any("ORC" in w for w in p["warnings"])


def test_inventory_import_refuses_business_object_source(client, monkeypatch):
    # A bucket with no discovered inventory evidence source cannot be imported.
    pid = _provider(client)
    run_id = _seed_profile(pid, inventory=False)
    _use(monkeypatch, _inventory_fake())
    r = _plan(client, run_id, "inventory")
    assert r.status_code == 422


def test_inventory_import_requires_confirmation_before_download(client, monkeypatch):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    _use(monkeypatch, _inventory_fake())
    p = _plan(client, run_id, "inventory").json()
    r = client.post(f"/evidence-imports/{p['id']}/run")
    assert r.status_code == 409  # not confirmed


def test_inventory_import_respects_max_files(client, monkeypatch):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    extra = [{"key": f"inv/2026-01-01/data/file{i}.csv.gz", "size": 100} for i in range(2, 6)]
    fake = _inventory_fake(extra_files=extra)
    # also list the extra objects so prefix-listing wouldn't be needed (manifest drives it)
    _use(monkeypatch, fake)
    p = _plan(client, run_id, "inventory", max_files=2).json()
    assert p["selected_file_count"] == 2
    assert any("truncated" in w.lower() for w in p["warnings"])


def test_inventory_import_respects_max_bytes(client, monkeypatch):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    extra = [{"key": f"inv/2026-01-01/data/file{i}.csv.gz", "size": 1000} for i in range(2, 6)]
    fake = _inventory_fake(extra_files=extra, data_size=1000)
    _use(monkeypatch, fake)
    p = _plan(client, run_id, "inventory", max_bytes=2500).json()
    assert p["selected_total_bytes"] <= 2500
    assert p["selected_file_count"] <= 2


def test_inventory_import_into_analysis_and_app_dir(client, monkeypatch, sync_runs, tmp_path):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    _use(monkeypatch, _inventory_fake())
    p = _plan(client, run_id, "inventory").json()
    assert client.post(f"/evidence-imports/{p['id']}/confirm").json()["status"] == "confirmed"
    res = client.post(f"/evidence-imports/{p['id']}/run").json()
    analysis_run_id = res["analysis_run_id"]
    assert res["status"] == "imported" and res["downloaded_file_count"] == 1

    detail = client.get(f"/runs/{analysis_run_id}").json()
    assert detail["status"] == "completed"
    assert detail["run_type"] == "inventory_analysis"
    report = client.get(f"/reports/{analysis_run_id}").json()["content"]
    assert "# Inventory Analysis Report" in report
    assert ACCESS not in report

    # dataset stored under the app data dir, not the install dir
    ds = client.get("/datasets").json()
    mine = [d for d in ds if d["run_id"] == analysis_run_id]
    assert mine and mine[0]["stored_path"].startswith("runs/")
    assert (tmp_path / mine[0]["stored_path"]).exists()
    assert mine[0]["name"] == "managed_evidence_import"

    # only the evidence destination was ever touched; business bucket never scanned
    fake_calls = []  # validated below via the shared fake


def test_inventory_only_touches_destination_bucket(client, monkeypatch, sync_runs):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    fake = _inventory_fake()
    _use(monkeypatch, fake)
    p = _plan(client, run_id, "inventory").json()
    client.post(f"/evidence-imports/{p['id']}/confirm")
    client.post(f"/evidence-imports/{p['id']}/run")
    buckets_listed = {b for (op, b, _x) in fake.calls if op == "list"}
    buckets_got = {b for (op, b, _x) in fake.calls if op == "get"}
    assert buckets_listed == {INV_DEST}
    assert buckets_got == {INV_DEST}
    assert BUSINESS not in buckets_listed and BUSINESS not in buckets_got
    # every get was for a planned/manifest key under the destination
    got_keys = {k for (op, b, k) in fake.calls if op == "get"}
    assert got_keys <= {_INV_MANIFEST_KEY, _INV_DATA_KEY}


# --- access log plan tests --------------------------------------------------

_LOG_TEXT = (
    '2026-06-25T10:00:00Z bucket-alpha GET /datasets/train/p1.parquet 206 1048576 42 ms '
    'user-agent="aws-sdk/1.0" remote_ip="192.0.2.10"\n'
    '2026-06-25T10:00:02Z bucket-alpha GET /private/secret.txt 403 0 12 ms '
    f'user-agent="{BEARER}" remote_ip="192.0.2.12"\n'
)


def _logging_fake(n=2, size=500, lm="2026-06-25T10:00:00"):
    objects = {LOG_DEST: [
        {"Key": f"access/2026-06-25-{i:02d}.log", "Size": size, "LastModified": _dtm(lm)}
        for i in range(n)
    ]}
    blobs = {(LOG_DEST, f"access/2026-06-25-{i:02d}.log"): _LOG_TEXT.encode() for i in range(n)}
    return FakeS3(objects, blobs)


def test_access_log_plan_requires_time_range(client, monkeypatch):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    _use(monkeypatch, _logging_fake())
    r = _plan(client, run_id, "access_log")  # no time range
    assert r.status_code == 422


def test_access_log_plan_accepts_naive_timestamp(client, monkeypatch):
    """A naive (offset-less) timestamp must be normalized to UTC, not raise a
    naive/aware TypeError → 500 when compared to a tz-aware LastModified."""
    pid = _provider(client)
    run_id = _seed_profile(pid)
    # LastModified is offset-aware here; the request time range is naive.
    fake = _logging_fake(n=2, lm="2026-06-25T10:00:00+00:00")
    _use(monkeypatch, fake)
    r = _plan(client, run_id, "access_log",
              time_range_start="2026-07-01T00:00:00", time_range_end="2026-07-02T00:00:00")
    assert r.status_code == 201, r.text  # not a 500
    # The naive window is before the log timestamps → nothing selected, cleanly.
    assert r.json()["selected_file_count"] == 0


def test_access_log_plan_bounded_to_target_prefix(client, monkeypatch):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    fake = _logging_fake(n=3)
    _use(monkeypatch, fake)
    r = _plan(client, run_id, "access_log",
              time_range_start="2026-06-25T00:00:00", time_range_end="2026-06-26T00:00:00")
    assert r.status_code == 201
    assert all(b == LOG_DEST and pfx == "access/" for (op, b, pfx) in fake.calls if op == "list")


def test_access_log_respects_max_files(client, monkeypatch):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    _use(monkeypatch, _logging_fake(n=5))
    p = _plan(client, run_id, "access_log", max_files=2,
              time_range_start="2026-06-25T00:00:00", time_range_end="2026-06-26T00:00:00").json()
    assert p["selected_file_count"] == 2


def test_access_log_respects_max_bytes(client, monkeypatch):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    _use(monkeypatch, _logging_fake(n=5, size=1000))
    p = _plan(client, run_id, "access_log", max_bytes=2500,
              time_range_start="2026-06-25T00:00:00", time_range_end="2026-06-26T00:00:00").json()
    assert p["selected_total_bytes"] <= 2500


def test_access_log_time_range_filters_out_of_range(client, monkeypatch):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    _use(monkeypatch, _logging_fake(n=2, lm="2020-01-01T00:00:00"))  # before the window
    p = _plan(client, run_id, "access_log",
              time_range_start="2026-06-25T00:00:00", time_range_end="2026-06-26T00:00:00").json()
    assert p["selected_file_count"] == 0


def test_access_log_import_into_analysis_and_redacted(client, monkeypatch, sync_runs):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    _use(monkeypatch, _logging_fake(n=2))
    p = _plan(client, run_id, "access_log",
              time_range_start="2026-06-25T00:00:00", time_range_end="2026-06-26T00:00:00").json()
    client.post(f"/evidence-imports/{p['id']}/confirm")
    res = client.post(f"/evidence-imports/{p['id']}/run").json()
    detail = client.get(f"/runs/{res['analysis_run_id']}").json()
    assert detail["status"] == "completed" and detail["run_type"] == "access_log_analysis"
    report = client.get(f"/reports/{res['analysis_run_id']}").json()["content"]
    assert "# Access Log Analysis Report" in report
    assert ACCESS not in report
    assert "sk-LEAK-TOKEN-123" not in report      # secret redacted
    assert "192.0.2.10" not in report             # client IP masked


# --- download safety --------------------------------------------------------


def test_download_only_uses_confirmed_files(client, monkeypatch, sync_runs):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    fake = _logging_fake(n=2)
    _use(monkeypatch, fake)
    p = _plan(client, run_id, "access_log",
              time_range_start="2026-06-25T00:00:00", time_range_end="2026-06-26T00:00:00").json()
    planned_keys = {f["object_key"] for f in p["files"] if f["selected"]}
    client.post(f"/evidence-imports/{p['id']}/confirm")
    client.post(f"/evidence-imports/{p['id']}/run")
    got_keys = {k for (op, b, k) in fake.calls if op == "get"}
    assert got_keys <= planned_keys  # never fetched a key outside the confirmed list


def test_download_fails_on_byte_limit_overflow(client, monkeypatch, sync_runs):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    # declared size 5 (passes plan with max_bytes=10) but the real blob is large
    big = "x" * 100
    objects = {LOG_DEST: [{"Key": "access/big.log", "Size": 5, "LastModified": _dtm("2026-06-25T10:00:00")}]}
    blobs = {(LOG_DEST, "access/big.log"): big.encode()}
    _use(monkeypatch, FakeS3(objects, blobs))
    p = _plan(client, run_id, "access_log", max_bytes=10,
              time_range_start="2026-06-25T00:00:00", time_range_end="2026-06-26T00:00:00").json()
    client.post(f"/evidence-imports/{p['id']}/confirm")
    r = client.post(f"/evidence-imports/{p['id']}/run")
    assert r.status_code == 400  # LimitExceeded
    assert client.get(f"/evidence-imports/{p['id']}").json()["status"] == "failed"


# --- approval + audit -------------------------------------------------------


def test_confirm_records_approval_and_audit(client, monkeypatch):
    pid = _provider(client)
    run_id = _seed_profile(pid)
    _use(monkeypatch, _inventory_fake())
    p = _plan(client, run_id, "inventory").json()
    client.post(f"/evidence-imports/{p['id']}/confirm")
    conn = _db()
    try:
        appr = conn.execute(
            "SELECT count(*) FROM approval_events WHERE action = 'evidence_import.download' AND decision='approved'"
        ).fetchone()[0]
        aud = conn.execute(
            "SELECT count(*) FROM audit_logs WHERE event_type LIKE 'evidence_import.%'"
        ).fetchone()[0]
    finally:
        conn.close()
    assert appr >= 1 and aud >= 1


def test_evidence_import_404s(client):
    assert client.get("/evidence-imports/nope").status_code == 404
    assert client.post("/evidence-imports/nope/confirm").status_code == 404
    assert client.post("/evidence-imports/nope/run").status_code == 404


# --- memory-safety: bounded gunzip + streaming combine (fix 3) ---------------


def test_gunzip_bomb_is_refused(tmp_path):
    """A gzip file that expands far beyond the ratio bound is refused as a
    possible decompression bomb instead of exhausting memory/disk."""
    from app.evidence import managed_import as mi

    # 8 MiB of zeros compresses to a few KB → >200x ratio and >4 MiB output.
    part = tmp_path / "part_00000"
    part.write_bytes(gzip.compress(b"\x00" * (8 * 1024 * 1024)))
    out_path = tmp_path / "out.log"
    with out_path.open("wb") as fh:
        writer = mi._TrackedWriter(fh)
        with pytest.raises(mi.LimitExceeded):
            mi._append_maybe_gunzip(part, writer)


def test_combine_access_logs_streams_and_gunzips(tmp_path):
    """Parts stream from disk and gzip parts are transparently decompressed."""
    from app.evidence import managed_import as mi

    p1 = tmp_path / "part_00000"
    p1.write_bytes(gzip.compress(b"GET /a 200\nGET /b 404\n"))
    p2 = tmp_path / "part_00001"
    p2.write_bytes(b"GET /c 200\n")  # plain, no trailing newline handling exercised
    combined = mi._combine_access_logs([p1, p2], tmp_path)
    text = combined.read_text()
    assert "GET /a 200" in text and "GET /c 200" in text


def test_combine_headerless_inventory_parts_lose_no_rows(tmp_path):
    """No-manifest fallback: S3 Inventory parts are HEADERLESS — skipping each
    subsequent part's 'header' silently dropped its first DATA row."""
    from app.evidence import managed_import as mi

    p1 = tmp_path / "part_00000"
    p1.write_bytes(b'"b","k1","10"\n"b","k2","20"\n')
    p2 = tmp_path / "part_00001"
    p2.write_bytes(b'"b","k3","30"\n"b","k4","40"\n')
    combined = mi._combine_inventory([p1, p2], "csv", None, tmp_path)
    text = combined.read_text()
    for k in ("k1", "k2", "k3", "k4"):
        assert k in text, f"row {k} lost in combine"


def test_combine_headered_parts_still_dedupe_headers(tmp_path):
    from app.evidence import managed_import as mi

    p1 = tmp_path / "h_00000"
    p1.write_bytes(b"Bucket,Key,Size\nb,k1,10\n")
    p2 = tmp_path / "h_00001"
    p2.write_bytes(b"Bucket,Key,Size\nb,k2,20\n")
    combined = mi._combine_inventory([p1, p2], "csv", None, tmp_path)
    text = combined.read_text()
    assert text.count("Bucket,Key,Size") == 1  # one header kept
    assert "k1" in text and "k2" in text


def test_claim_for_import_is_atomic(client, monkeypatch):
    """Two concurrent confirmed→importing claims: exactly one wins."""
    from app.repositories import evidence_imports as repo

    pid = _provider(client)
    run_id = _seed_profile(pid)
    _use(monkeypatch, _inventory_fake())
    p = _plan(client, run_id, "inventory").json()
    client.post(f"/evidence-imports/{p['id']}/confirm")

    conn = _db()
    try:
        first = repo.claim_for_import(conn, p["id"], "run-a")
        second = repo.claim_for_import(conn, p["id"], "run-b")
    finally:
        conn.close()
    assert first is True and second is False
