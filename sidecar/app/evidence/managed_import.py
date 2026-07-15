"""Plan + download + combine for managed evidence import.

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

import json
import shutil
import sqlite3
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO

from botocore.exceptions import ClientError

from ..s3 import client_factory
from ..security.redaction import redact_text

# Bounds (caller may lower; never raise above the hard caps).
DEFAULT_MAX_FILES = 1000
DEFAULT_MAX_BYTES = 1 * 1024 * 1024 * 1024  # 1 GiB
HARD_MAX_FILES = 5000
HARD_MAX_BYTES = 5 * 1024 * 1024 * 1024  # 5 GiB
_LIST_HARD_CAP = 5000  # max objects we will ever enumerate under the prefix
_MANIFEST_MAX_BYTES = 8 * 1024 * 1024  # inventory manifest.json is small
_CHUNK = 1024 * 1024
# Decompression-bomb guard: a gzip member may emit at most this many bytes per
# compressed byte (plus a small floor for tiny files). Real inventory/access-log
# gzip runs well under 100:1; a crafted bomb (KBs expanding to GBs) trips this
# long before it exhausts disk. Tied to the confirmed byte budget: the budget
# bounds the compressed input, and this ratio bounds the decompressed output.
_GUNZIP_MAX_RATIO = 1000
_GUNZIP_MIN_OUT_CAP = 4 * _CHUNK


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
    """Parse an ISO-8601 timestamp, normalizing naive inputs to UTC.

    Users (and providers' LastModified serializations) mix naive and offset-
    aware timestamps; comparing the two raises TypeError, which used to surface
    as a 500 on ``POST /evidence-imports/plan``. A missing offset is treated as
    UTC so ``_within_range`` always compares aware datetimes.
    """
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


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
            "ORC inventory format isn't supported yet — re-export the inventory "
            "as CSV or Parquet, which both analyze.",
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
#
# Memory safety: downloads STREAM to per-part temp files on disk (never a list
# of blobs in RAM — the old approach could hold up to the full 5 GiB hard cap in
# memory), gzip decompression is BOUNDED (a crafted decompression bomb raises
# LimitExceeded instead of exhausting RAM/disk; see _GUNZIP_MAX_RATIO), and the
# combine step is streaming/out-of-core. A legitimate import never needs RAM
# proportional to its size.


def _stream_object_to_file(client, bucket: str, key: str, dest: Path, cap: int) -> int:
    """Stream one object body to ``dest``, refusing to read more than ``cap`` bytes."""
    resp = client.get_object(Bucket=bucket, Key=key)
    body = resp.get("Body")
    got = 0
    try:
        with dest.open("wb") as fh:
            if body is None:
                return 0
            while True:
                chunk = body.read(_CHUNK)
                if not chunk:
                    break
                got += len(chunk)
                if got > cap:
                    raise LimitExceeded(f"object exceeds the {cap}-byte budget")
                fh.write(chunk)
    finally:
        if body is not None and hasattr(body, "close"):
            body.close()
    return got


def _gunzip_out_cap(compressed_size: int) -> int:
    return max(_GUNZIP_MIN_OUT_CAP, _GUNZIP_MAX_RATIO * compressed_size)


class _TrackedWriter:
    """Wrap a binary writer, remembering the last byte written (newline bookkeeping)."""

    def __init__(self, fh: BinaryIO) -> None:
        self._fh = fh
        self.last: bytes | None = None
        self.wrote = False

    def write(self, data: bytes) -> None:
        if not data:
            return
        self._fh.write(data)
        self.last = data[-1:]
        self.wrote = True


class _SkipFirstLineWriter:
    """Writer adapter that drops everything up to and including the first newline."""

    def __init__(self, inner: _TrackedWriter) -> None:
        self._inner = inner
        self._skipping = True

    @property
    def last(self) -> bytes | None:
        return self._inner.last

    @property
    def wrote(self) -> bool:
        return self._inner.wrote

    def write(self, data: bytes) -> None:
        if self._skipping:
            i = data.find(b"\n")
            if i == -1:
                return
            self._skipping = False
            data = data[i + 1:]
        self._inner.write(data)


def _append_maybe_gunzip(src: Path, out) -> None:
    """Stream ``src`` into ``out``, transparently gunzipping (bounded).

    Non-gzip content (and content that merely starts with the gzip magic but is
    not a valid stream) is copied through verbatim, matching the old
    best-effort behavior. Decompressed output is capped at
    ``_GUNZIP_MAX_RATIO`` x the compressed size — beyond that it is treated as
    a decompression bomb and the import fails with LimitExceeded.
    """
    size = src.stat().st_size
    with src.open("rb") as fh:
        magic = fh.read(2)
        fh.seek(0)
        if magic != b"\x1f\x8b":
            _copy_stream(fh, out)
            return
        out_cap = _gunzip_out_cap(size)
        d = zlib.decompressobj(wbits=31)  # gzip container
        written = 0
        had_eof = False  # decoded at least one complete gzip member
        try:
            # `data` is the input still to feed. Concatenated (multi-member) gzip
            # must be decoded member by member — a single decompressobj stops at
            # the first member's end (d.eof) and exposes the rest via unused_data.
            # The old gzip.decompress handled this; decoding only the first member
            # silently DROPS every later member.
            data = fh.read(_CHUNK)
            while True:
                while data:
                    piece = d.decompress(data, _CHUNK)
                    written += len(piece)
                    if written > out_cap:
                        raise LimitExceeded(
                            "gzip evidence file expands beyond the decompression "
                            f"bound ({out_cap} bytes for {size} compressed bytes); "
                            "refusing a possible decompression bomb"
                        )
                    out.write(piece)
                    data = d.unconsumed_tail
                    if d.eof:
                        had_eof = True
                        rest = d.unused_data
                        if rest[:2] == b"\x1f\x8b":
                            d = zlib.decompressobj(wbits=31)  # next member
                            data = rest
                        elif rest:
                            return  # trailing non-gzip bytes: stop (like gzip)
                        else:
                            d = zlib.decompressobj(wbits=31)  # maybe more in file
                            data = b""
                nxt = fh.read(_CHUNK)
                if not nxt:
                    break
                data = nxt
            if not had_eof:
                # No complete member decoded → truncated/invalid gzip.
                raise zlib.error("truncated gzip stream")
        except zlib.error:
            if written:
                # Partial decompressed output already streamed; mixing raw bytes
                # after it would corrupt the combined file. Fail cleanly instead.
                raise ImportError_("gzip evidence file is corrupt (stream failed mid-way)")
            fh.seek(0)
            _copy_stream(fh, out)


def _copy_stream(fh: BinaryIO, out) -> None:
    while True:
        chunk = fh.read(_CHUNK)
        if not chunk:
            break
        out.write(chunk)


def _append_with_newline(src: Path, out: _TrackedWriter) -> None:
    _append_maybe_gunzip(src, out)
    if out.wrote and out.last != b"\n":
        out.write(b"\n")


def _combine_access_logs(parts: list[Path], dest_dir: Path) -> Path:
    out_path = dest_dir / "combined.log"
    with out_path.open("wb") as fh:
        for part in parts:
            writer = _TrackedWriter(fh)
            _append_with_newline(part, writer)
    return out_path


def _combine_inventory(parts: list[Path], fmt: str, schema: str | None, dest_dir: Path) -> Path:
    if fmt == "parquet":
        # Combine out-of-core via DuckDB (never all frames in RAM at once).
        # Parts may be gzip-wrapped parquet; unwrap those to disk first.
        import duckdb

        plain: list[Path] = []
        for i, part in enumerate(parts):
            with part.open("rb") as fh:
                is_gz = fh.read(2) == b"\x1f\x8b"
            if is_gz:
                unpacked = part.with_name(part.name + ".parquet")
                with unpacked.open("wb") as fh:
                    _append_maybe_gunzip(part, fh)
                plain.append(unpacked)
            else:
                plain.append(part)
        out_path = dest_dir / "combined.parquet"
        con = duckdb.connect()
        try:
            files_sql = ", ".join("'" + str(p).replace("'", "''") + "'" for p in plain)
            out_sql = str(out_path).replace("'", "''")
            con.execute(
                f"COPY (SELECT * FROM read_parquet([{files_sql}])) "
                f"TO '{out_sql}' (FORMAT PARQUET)"
            )
        finally:
            con.close()
        return out_path

    # CSV (default). S3 inventory CSVs are headerless; the manifest fileSchema
    # provides the column names, which we write as the header so the existing
    # header-based importer can map columns.
    out_path = dest_dir / "combined.csv"
    with out_path.open("wb") as fh:
        if schema:
            header = ",".join(c.strip() for c in schema.split(","))
            fh.write(header.encode("utf-8") + b"\n")
            for part in parts:
                writer = _TrackedWriter(fh)
                _append_with_newline(part, writer)
        else:
            # No schema (prefix-listing fallback, no manifest). Only skip the
            # first line of subsequent parts when the parts REALLY carry a
            # header: S3 Inventory CSVs are headerless (and access-log parts are
            # raw lines), so unconditionally skipping dropped the first DATA
            # row/log line of every part after the first. Peek at part 0's first
            # line and skip only if it looks like an inventory header.
            headered = _first_line_looks_like_header(parts[0]) if parts else False
            for i, part in enumerate(parts):
                tracked = _TrackedWriter(fh)
                writer = tracked if (i == 0 or not headered) else _SkipFirstLineWriter(tracked)
                _append_maybe_gunzip(part, writer)
                if writer.wrote and writer.last != b"\n":
                    tracked.write(b"\n")
    return out_path


def _first_line_looks_like_header(part: Path) -> bool:
    """Best-effort: does this (possibly gzipped) part start with a CSV header
    row of known inventory column names? Bounded read; any failure → False
    (treat as headerless, which never loses data)."""
    from ..analysis.inventory import _looks_like_header
    try:
        with part.open("rb") as fh:
            head = fh.read(65536)
        if head[:2] == b"\x1f\x8b":
            head = zlib.decompressobj(wbits=31).decompress(head, 65536)
        first = head.split(b"\n", 1)[0].decode("utf-8", "replace").strip()
        return bool(first) and _looks_like_header([c.strip().strip('"') for c in first.split(",")])
    except Exception:  # noqa: BLE001
        return False


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
    not in the confirmed list. Bodies stream to per-part temp files under the
    run's raw dir and are combined from disk (see the memory-safety note above);
    the parts are removed once the combined file exists.
    """
    if len(files) > max_files:
        raise LimitExceeded(f"{len(files)} files exceeds max_files={max_files}")
    client = client_factory.build_s3_client(conn, provider_id)
    dest_dir.mkdir(parents=True, exist_ok=True)

    parts_dir = dest_dir / "parts"
    parts_dir.mkdir(parents=True, exist_ok=True)
    try:
        parts: list[Path] = []
        total = 0
        for i, f in enumerate(files):
            remaining = max_bytes - total
            if remaining <= 0:
                raise LimitExceeded("byte budget exhausted")
            part = parts_dir / f"part_{i:05d}"
            total += _stream_object_to_file(client, source_bucket, f["object_key"], part, remaining)
            parts.append(part)

        if source_type == "inventory":
            combined = _combine_inventory(parts, (fmt or "csv"), schema, dest_dir)
        else:
            combined = _combine_access_logs(parts, dest_dir)
    finally:
        shutil.rmtree(parts_dir, ignore_errors=True)
    return combined, total
