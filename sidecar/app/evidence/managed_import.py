"""Plan + download + combine for managed evidence import (Phase 15).

All S3 access here is READ-ONLY and confined to a *discovered* evidence
destination (inventory destination bucket/prefix, or server-access-logging
target bucket/prefix). It performs:

- a bounded ``list_objects_v2`` over that destination prefix only (never a
  business bucket, never the whole account);
- ``get_object`` ONLY for evidence files in the confirmed plan, capped by
  max_files / max_bytes.

It never calls any mutating/destructive S3 API, never downloads business object
bodies, never recursively copies/syncs, and never auto-enables logging or
inventory. Credentials are resolved inside the boto3 client factory and never
returned, logged, or persisted.
"""

from __future__ import annotations

import gzip
import io
import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError

from ..s3 import client_factory
from ..s3 import config_tools as ct
from ..security.redaction import redact_text

# Bounds (caller may lower; never raise above the hard caps).
DEFAULT_MAX_FILES = 1000
DEFAULT_MAX_BYTES = 1 * 1024 * 1024 * 1024  # 1 GiB
HARD_MAX_FILES = 5000
HARD_MAX_BYTES = 5 * 1024 * 1024 * 1024  # 5 GiB
_LIST_HARD_CAP = 5000  # max objects we will ever enumerate under the prefix
_MANIFEST_MAX_BYTES = 8 * 1024 * 1024  # inventory manifest.json is small
_CHUNK = 1024 * 1024


class ImportError_(Exception):
    """Raised when a plan/limitation/bound makes the import impossible."""


class LimitExceeded(ImportError_):
    """Raised when a download would exceed the confirmed file/byte budget."""


@dataclass
class Plan:
    source_type: str
    source_bucket: str | None
    source_prefix: str | None
    evidence_ref: str | None
    fmt: str | None
    plan_source: str
    schema: str | None
    max_files: int
    max_bytes: int
    time_range_start: str | None
    time_range_end: str | None
    planned_file_count: int
    planned_total_bytes: int
    selected: list[dict[str, Any]] = field(default_factory=list)
    all_files: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def selected_total_bytes(self) -> int:
        return sum(int(f.get("size") or 0) for f in self.selected)


def clamp_bounds(max_files: int | None, max_bytes: int | None) -> tuple[int, int]:
    mf = DEFAULT_MAX_FILES if not max_files else int(max_files)
    mb = DEFAULT_MAX_BYTES if not max_bytes else int(max_bytes)
    return max(1, min(mf, HARD_MAX_FILES)), max(1, min(mb, HARD_MAX_BYTES))


# --- read-only S3 primitives ------------------------------------------------


def _list_prefix(client, bucket: str, prefix: str, hard_cap: int = _LIST_HARD_CAP) -> list[dict[str, Any]]:
    """Bounded listing of one destination prefix (objects only, no delimiter)."""
    out: list[dict[str, Any]] = []
    token: str | None = None
    while len(out) < hard_cap:
        kw: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix or "",
                              "MaxKeys": min(1000, hard_cap - len(out))}
        if token:
            kw["ContinuationToken"] = token
        resp = client.list_objects_v2(**kw)
        for c in resp.get("Contents", []) or []:
            lm = c.get("LastModified")
            out.append({
                "key": c.get("Key"),
                "size": int(c.get("Size") or 0),
                "last_modified": lm.isoformat() if hasattr(lm, "isoformat") else lm,
            })
        if resp.get("IsTruncated") and resp.get("NextContinuationToken"):
            token = resp["NextContinuationToken"]
        else:
            break
    return out


def _get_object_bytes(client, bucket: str, key: str, cap: int) -> bytes:
    """Download one object body, refusing to read more than ``cap`` bytes."""
    resp = client.get_object(Bucket=bucket, Key=key)
    body = resp.get("Body")
    if body is None:
        return b""
    chunks: list[bytes] = []
    got = 0
    while True:
        chunk = body.read(_CHUNK)
        if not chunk:
            break
        got += len(chunk)
        if got > cap:
            if hasattr(body, "close"):
                body.close()
            raise LimitExceeded(f"object exceeds the {cap}-byte budget")
        chunks.append(chunk)
    if hasattr(body, "close"):
        body.close()
    return b"".join(chunks)


# --- time helpers -----------------------------------------------------------


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _within_range(lm_iso: str | None, start: datetime | None, end: datetime | None) -> bool:
    if start is None and end is None:
        return True
    lm = parse_iso(lm_iso)
    if lm is None:
        # Cannot place it in time; keep it (still bounded by max_files/max_bytes).
        return True
    if start and lm < start:
        return False
    if end and lm > end:
        return False
    return True


def _select_within_bounds(files: list[dict[str, Any]], max_files: int, max_bytes: int) -> tuple[list[dict[str, Any]], bool]:
    selected: list[dict[str, Any]] = []
    total = 0
    truncated = False
    for f in files:
        if len(selected) >= max_files:
            truncated = True
            break
        size = int(f.get("size") or 0)
        if total + size > max_bytes:
            truncated = True
            break
        selected.append({**f, "selected": True})
        total += size
    return selected, truncated


# --- inventory planning -----------------------------------------------------

_INV_DATA_SUFFIXES = (".csv", ".csv.gz", ".parquet", ".parquet.gz", ".orc", ".gz")


def plan_inventory(
    conn: sqlite3.Connection,
    provider_id: str,
    dest_bucket: str,
    dest_prefix: str,
    evidence_ref: str | None,
    declared_format: str | None,
    max_files: int,
    max_bytes: int,
) -> Plan:
    client = client_factory.build_s3_client(conn, provider_id)
    warnings: list[str] = []
    listed = _list_prefix(client, dest_bucket, dest_prefix)
    fmt = (declared_format or "").lower()
    schema: str | None = None
    data_files: list[dict[str, Any]] = []
    plan_source = "prefix_listing"

    manifests = [o for o in listed if str(o["key"]).endswith("manifest.json")]
    if manifests:
        plan_source = "manifest"
        manifest_obj = sorted(manifests, key=lambda o: o["key"])[-1]
        try:
            raw = _get_object_bytes(client, dest_bucket, manifest_obj["key"], _MANIFEST_MAX_BYTES)
            manifest = json.loads(raw.decode("utf-8"))
        except (ClientError, ValueError, UnicodeDecodeError, LimitExceeded) as exc:
            return _limitation_plan(
                "inventory", dest_bucket, dest_prefix, evidence_ref, max_files, max_bytes,
                f"Inventory manifest could not be read/parsed: {redact_text(str(exc))}",
            )
        fmt = (manifest.get("fileFormat") or fmt or "").lower()
        schema = manifest.get("fileSchema")
        for f in manifest.get("files", []) or []:
            data_files.append({"key": f.get("key"), "size": int(f.get("size") or 0), "kind": "data"})
    else:
        warnings.append(
            "No manifest.json found under the inventory destination prefix; using a "
            "bounded prefix listing of inventory artifacts instead."
        )
        for o in listed:
            k = str(o["key"]).lower()
            if k.endswith(_INV_DATA_SUFFIXES) and not k.endswith("manifest.checksum"):
                data_files.append({"key": o["key"], "size": o["size"], "kind": "data"})
        if not fmt:
            fmt = "parquet" if any(str(d["key"]).lower().endswith((".parquet", ".parquet.gz"))
                                   for d in data_files) else "csv"

    if fmt == "orc":
        plan = _limitation_plan(
            "inventory", dest_bucket, dest_prefix, evidence_ref, max_files, max_bytes,
            "Inventory format ORC was detected_but_not_supported in this phase; "
            "use CSV or Parquet inventory output.",
        )
        plan.fmt = "orc"
        plan.plan_source = plan_source
        return plan

    if not data_files:
        return _limitation_plan(
            "inventory", dest_bucket, dest_prefix, evidence_ref, max_files, max_bytes,
            "No inventory data files were found under the discovered destination prefix.",
        )

    selected, truncated = _select_within_bounds(data_files, max_files, max_bytes)
    if truncated:
        warnings.append("Selection truncated to stay within max_files / max_bytes.")
    return Plan(
        source_type="inventory", source_bucket=dest_bucket, source_prefix=dest_prefix,
        evidence_ref=evidence_ref, fmt=fmt or "csv", plan_source=plan_source, schema=schema,
        max_files=max_files, max_bytes=max_bytes, time_range_start=None, time_range_end=None,
        planned_file_count=len(data_files),
        planned_total_bytes=sum(int(d.get("size") or 0) for d in data_files),
        selected=selected, all_files=data_files, warnings=warnings,
    )


# --- access log planning ----------------------------------------------------


def plan_access_log(
    conn: sqlite3.Connection,
    provider_id: str,
    target_bucket: str,
    target_prefix: str,
    evidence_ref: str | None,
    time_range_start: str,
    time_range_end: str,
    max_files: int,
    max_bytes: int,
) -> Plan:
    client = client_factory.build_s3_client(conn, provider_id)
    warnings: list[str] = []
    start = parse_iso(time_range_start)
    end = parse_iso(time_range_end)

    listed = _list_prefix(client, target_bucket, target_prefix)
    in_range = [
        {"key": o["key"], "size": o["size"], "kind": "log", "last_modified": o.get("last_modified")}
        for o in listed
        if _within_range(o.get("last_modified"), start, end)
    ]
    if not in_range:
        warnings.append("No log objects matched the time range under the discovered logging target prefix.")

    selected, truncated = _select_within_bounds(in_range, max_files, max_bytes)
    if truncated:
        warnings.append("Selection truncated to stay within max_files / max_bytes.")
    return Plan(
        source_type="access_log", source_bucket=target_bucket, source_prefix=target_prefix,
        evidence_ref=evidence_ref, fmt="text", plan_source="prefix_listing", schema=None,
        max_files=max_files, max_bytes=max_bytes,
        time_range_start=time_range_start, time_range_end=time_range_end,
        planned_file_count=len(in_range),
        planned_total_bytes=sum(int(d.get("size") or 0) for d in in_range),
        selected=selected, all_files=in_range, warnings=warnings,
    )


def _limitation_plan(source_type, bucket, prefix, ref, max_files, max_bytes, message) -> Plan:
    return Plan(
        source_type=source_type, source_bucket=bucket, source_prefix=prefix, evidence_ref=ref,
        fmt=None, plan_source="limitation", schema=None, max_files=max_files, max_bytes=max_bytes,
        time_range_start=None, time_range_end=None, planned_file_count=0, planned_total_bytes=0,
        selected=[], all_files=[], warnings=[message],
    )


# --- download + combine -----------------------------------------------------


def _maybe_gunzip(data: bytes) -> bytes:
    if data[:2] == b"\x1f\x8b":
        try:
            return gzip.decompress(data)
        except OSError:
            return data
    return data


def _combine_access_logs(blobs: list[bytes], dest_dir: Path) -> Path:
    out = dest_dir / "combined.log"
    with out.open("wb") as fh:
        for b in blobs:
            text = _maybe_gunzip(b)
            fh.write(text)
            if not text.endswith(b"\n"):
                fh.write(b"\n")
    return out


def _combine_inventory(blobs: list[bytes], fmt: str, schema: str | None, dest_dir: Path) -> Path:
    if fmt == "parquet":
        import pandas as pd

        frames = [pd.read_parquet(io.BytesIO(_maybe_gunzip(b))) for b in blobs]
        combined = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        out = dest_dir / "combined.parquet"
        combined.to_parquet(out, index=False)
        return out

    # CSV (default). S3 inventory CSVs are headerless; the manifest fileSchema
    # provides the column names, which we write as the header so the existing
    # header-based importer can map columns.
    out = dest_dir / "combined.csv"
    with out.open("wb") as fh:
        if schema:
            header = ",".join(c.strip() for c in schema.split(","))
            fh.write(header.encode("utf-8") + b"\n")
            for b in blobs:
                text = _maybe_gunzip(b)
                fh.write(text)
                if not text.endswith(b"\n"):
                    fh.write(b"\n")
        else:
            # No schema: assume each file carries its own header; keep the first
            # file's header and drop subsequent header lines.
            for i, b in enumerate(blobs):
                text = _maybe_gunzip(b)
                if i == 0:
                    fh.write(text)
                    if not text.endswith(b"\n"):
                        fh.write(b"\n")
                else:
                    lines = text.split(b"\n", 1)
                    body = lines[1] if len(lines) > 1 else b""
                    fh.write(body)
                    if body and not body.endswith(b"\n"):
                        fh.write(b"\n")
    return out


def download_and_combine(
    conn: sqlite3.Connection,
    provider_id: str,
    source_type: str,
    source_bucket: str,
    fmt: str | None,
    schema: str | None,
    files: list[dict[str, Any]],
    max_files: int,
    max_bytes: int,
    dest_dir: Path,
) -> tuple[Path, int]:
    """Download the confirmed evidence files and combine into ONE local file.

    Returns (combined_path, downloaded_total_bytes). Enforces max_files /
    max_bytes a second time at download (defense in depth) and refuses anything
    not in the confirmed list.
    """
    if len(files) > max_files:
        raise LimitExceeded(f"{len(files)} files exceeds max_files={max_files}")
    client = client_factory.build_s3_client(conn, provider_id)
    dest_dir.mkdir(parents=True, exist_ok=True)

    blobs: list[bytes] = []
    total = 0
    for f in files:
        remaining = max_bytes - total
        if remaining <= 0:
            raise LimitExceeded("byte budget exhausted")
        data = _get_object_bytes(client, source_bucket, f["object_key"], remaining)
        total += len(data)
        blobs.append(data)

    if source_type == "inventory":
        combined = _combine_inventory(blobs, (fmt or "csv"), schema, dest_dir)
    else:
        combined = _combine_access_logs(blobs, dest_dir)
    return combined, total
