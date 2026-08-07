"""v0.64.0 — an object inventory was silently parsed as access logs.

`detect_log_format` called a CSV "access-log csv" when its header shared **one**
token with the access-log column list. An S3 inventory header is
`bucket,key,size,storage_class,last_modified` — `key` and `size` are both on that
list, so an inventory attached (or auto-typed) as access logs was ingested with
the object key as the request path and the object size as bytes sent. No row was
rejected and nothing said anything: the user got a table of request metrics where
every number was meaningless.

An inventory is the *other* file this product ingests, which makes it the one
false positive that matters. It is now identified by the columns only an
inventory has, and only when the header carries no request-shaped column — an
access-log export may legitimately name a `storage_class` alongside a status.

The frontend half of the same defect shipped with this: `inferDatasetType` tested
`name.includes("log")`, so `catalog.csv` and even `logical-inventory.parquet`
were auto-typed as access logs (see `frontend/src/datasetType.test.ts`).
"""
from __future__ import annotations

import pathlib

import pytest

from app.analysis import access_logs

INVENTORY_HEADER = "bucket,key,size,storage_class,last_modified"
INVENTORY_ROW = "acme-logs,logs/2026/06/part-{i}.parquet,{n},STANDARD,2026-06-01T00:00:00Z"

ACCESS_CSV_HEADER = "timestamp,method,path,status,bytes,user_agent,remote_ip"
ACCESS_CSV_ROW = "2026-06-25T10:00:0{i}Z,GET,/a/p{i}.parquet,200,{n},aws-sdk/1.0,192.0.2.10"


def _write(tmp_path: pathlib.Path, name: str, header: str, row: str, n: int = 25) -> pathlib.Path:
    p = tmp_path / name
    lines = [header] + [row.format(i=i, n=1048576 * (i + 1)) for i in range(n)]
    p.write_text("\n".join(lines) + "\n")
    return p


def test_an_inventory_is_not_called_an_access_log(tmp_path):
    p = _write(tmp_path, "catalog.csv", INVENTORY_HEADER, INVENTORY_ROW)
    assert access_logs.detect_log_format(p)["format"] == "inventory"


def test_importing_it_as_logs_refuses_instead_of_inventing_metrics(tmp_path):
    p = _write(tmp_path, "catalog.csv", INVENTORY_HEADER, INVENTORY_ROW)
    with pytest.raises(ValueError) as exc:
        access_logs.import_access_logs(p, tmp_path / "out.duckdb", "inventory")
    # The message has to name the fix; the user chose the type and can change it.
    assert "inventory" in str(exc.value).lower()
    assert "re-attach" in str(exc.value).lower()


def test_a_real_csv_access_log_still_imports(tmp_path):
    """The control. Tightening detection must not cost the format it exists for."""
    p = _write(tmp_path, "access.csv", ACCESS_CSV_HEADER, ACCESS_CSV_ROW)
    assert access_logs.detect_log_format(p)["format"] == "csv"
    out = access_logs.import_access_logs(p, tmp_path / "out.duckdb", "csv")
    assert out["row_count"] == 25


def test_a_log_export_that_happens_to_carry_a_storage_class_is_still_a_log(tmp_path):
    """An inventory-only token does NOT win on its own — a request-shaped column
    means the file really is a log, whatever else it names."""
    header = "timestamp,method,path,status,bytes,storage_class"
    row = "2026-06-25T10:00:0{i}Z,GET,/a/p{i}.parquet,200,{n},STANDARD"
    p = _write(tmp_path, "access.csv", header, row)
    assert access_logs.detect_log_format(p)["format"] == "csv"


@pytest.mark.parametrize("marker", [
    "version_id", "is_latest", "e_tag", "is_delete_marker", "replication_status",
])
def test_the_other_inventory_shapes_are_recognized_too(tmp_path, marker):
    p = _write(tmp_path, "inv.csv", f"bucket,key,size,{marker}", "acme,k/{i},{n},x")
    assert access_logs.detect_log_format(p)["format"] == "inventory"


def test_a_plain_text_log_is_untouched(tmp_path):
    p = tmp_path / "s3.log"
    p.write_text(
        '2026-06-25T10:00:00Z acme-logs GET /a/p1.parquet 200 1048576 42 ms '
        'user-agent="aws-sdk/1.0" remote_ip="192.0.2.10"\n'
    )
    assert access_logs.detect_log_format(p)["format"] == "text"


def test_jsonl_is_untouched(tmp_path):
    p = tmp_path / "events.jsonl"
    p.write_text('{"timestamp": "2026-06-25T10:00:00Z", "method": "GET", "status": 200}\n')
    assert access_logs.detect_log_format(p)["format"] == "jsonl"
