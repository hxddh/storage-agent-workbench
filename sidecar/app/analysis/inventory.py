"""Inventory analysis tools.

Reads a user-uploaded inventory file (CSV or Parquet), normalizes it into a
DuckDB ``inventory_objects`` table, and computes capacity / age / distribution
metrics. Read-only and analytical: it never deletes objects, changes lifecycle,
or downloads object bodies.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pandas as pd

from ..security.redaction import redact_text
from . import duck

TABLE_NAME = "inventory_objects"
SAMPLE_LIMIT = 20
SMALL_OBJECT_BYTES = 1024 * 1024  # objects under 1 MiB count as "small"
# Bound rows materialized in memory during import (see analysis/access_logs.py).
# A huge inventory export must not OOM the sidecar; rows beyond this are dropped.
MAX_INGEST_ROWS = 2_000_000

COLUMNS = ["bucket", "key", "prefix", "size", "last_modified", "storage_class", "etag"]

# normalized-name -> target field. Normalization strips spaces/underscores, lowercases.
_FIELD_CANDIDATES = {
    "bucket": ["bucket"],
    "key": ["key"],
    "size": ["size"],
    "last_modified": ["lastmodified", "lastmodifieddate"],
    "storage_class": ["storageclass"],
    "etag": ["etag"],
}


def _norm(name: str) -> str:
    return name.lower().replace(" ", "").replace("_", "")


# Storage-class tokens used to recognize the storage-class column in a HEADERLESS
# inventory CSV (S3 + common S3-compatible names).
_KNOWN_STORAGE = {
    "standard", "standard_ia", "onezone_ia", "reduced_redundancy", "glacier",
    "glacier_ir", "deep_archive", "intelligent_tiering", "outposts",
    "express_onezone", "cold", "archive", "tepid", "mtc",
}
# S3 inventory LastModifiedDate is ISO-8601 (e.g. 2024-01-15T10:30:00.000Z);
# accept date-only values too (some exports emit bare 2024-01-15, which DuckDB
# casts fine — it just needs the column MAPPED).
_TS_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]|$)")


def _is_epoch(s: str) -> bool:
    """A plausible unix timestamp: 10-digit seconds or 13-digit millis in
    ~2001–2100. Used both to DETECT an epoch modified-time column and to convert
    its values to ISO at import (DuckDB can't cast a bare epoch string)."""
    if not s.isdigit():
        return False
    if len(s) == 10:
        return 1_000_000_000 <= int(s) <= 4_102_444_800
    if len(s) == 13:
        return 1_000_000_000_000 <= int(s) <= 4_102_444_800_000
    return False


def _norm_ts(v: Any) -> str | None:
    """Normalize a last_modified cell for storage: epoch → ISO-8601; everything
    else passes through as text (DuckDB try_casts ISO/date strings itself)."""
    if v is None or str(v).strip() == "":
        return None
    s = str(v).strip()
    if _is_epoch(s):
        from datetime import datetime, timezone
        secs = int(s) / (1000 if len(s) == 13 else 1)
        return datetime.fromtimestamp(secs, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return s


def _looks_like_header(row: Any) -> bool:
    """True if a CSV's first row is a HEADER (column names) rather than data.

    S3 Inventory CSVs are HEADERLESS (the schema lives in the manifest), but a
    manifest-synthesized header (managed import) or a generic CSV has one.
    Recognized when >=2 cells normalize to known inventory field names — a real
    data row won't have two cells that are exactly 'bucket'/'key'/'size'/... .
    """
    known = {c for cands in _FIELD_CANDIDATES.values() for c in cands}
    hits = sum(1 for v in list(row) if _norm(str(v)) in known)
    return hits >= 2


def _detect_field_columns(df: pd.DataFrame) -> dict[str, Any]:
    """Map inventory fields to columns of a HEADERLESS CSV by VALUE SHAPE, so a raw
    S3 inventory export analyzes regardless of column order (the order is defined
    by the manifest, which the direct-upload path doesn't have). Best-effort:
    unmatched fields stay None and the analyzer degrades gracefully."""
    sample = df.head(500)
    cols = list(df.columns)
    used: set[Any] = set()

    def frac(col: Any, pred: Any) -> float:
        vals = [str(v).strip() for v in sample[col].tolist() if str(v).strip() != ""]
        return (sum(1 for v in vals if pred(v)) / len(vals)) if vals else 0.0

    assigned: dict[str, Any] = {}

    def claim(field: str, pred: Any, thresh: float) -> None:
        cand, score = max(
            ((c, frac(c, pred)) for c in cols if c not in used),
            key=lambda x: x[1], default=(None, 0.0))
        if cand is not None and score >= thresh:
            assigned[field] = cand
            used.add(cand)

    # Order matters. A DATE-shaped column claims last_modified first (unambiguous).
    # size claims next. Only AFTER size is taken does an EPOCH column claim
    # last_modified — otherwise, for a headerless GB-scale export with no
    # timestamp column, a 10-digit size (~1–4 GB) would be mis-claimed as an
    # epoch and steal the size mapping.
    claim("storage_class", lambda s: s.lower() in _KNOWN_STORAGE, 0.6)
    claim("last_modified", lambda s: bool(_TS_PREFIX.match(s)), 0.6)
    claim("size", lambda s: s.isdigit(), 0.8)
    if "last_modified" not in assigned and "size" in assigned:
        claim("last_modified", _is_epoch, 0.6)
    # key: the remaining column that is most path-like, else the longest strings.
    rem = [c for c in cols if c not in used]
    if rem:
        pathy, pscore = max(((c, frac(c, lambda s: "/" in s)) for c in rem),
                            key=lambda x: x[1])
        key_col = pathy if pscore >= 0.3 else max(
            rem, key=lambda c: sum(len(str(v)) for v in sample[c].tolist()))
        assigned["key"] = key_col
        used.add(key_col)
    # bucket: a remaining low-cardinality, non-numeric column (one repeated value).
    for c in (c for c in cols if c not in used):
        vals = {str(v) for v in sample[c].tolist() if str(v).strip() != ""}
        if vals and len(vals) <= 2 and not all(v.isdigit() for v in vals):
            assigned["bucket"] = c
            break
    return assigned


def _prefix_of(key: str) -> str:
    key = (key or "").lstrip("/")
    return key.split("/", 1)[0] + "/" if "/" in key else "(root)"


def _to_int(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        s = str(value).strip()
        # int() directly so an int64 size > 2^53 (up to ~9 PB) doesn't lose
        # precision through a float round-trip; float only for fractional strings.
        try:
            return int(s)
        except ValueError:
            return int(float(s))
    except (TypeError, ValueError):
        return None


def _load_dataframe(raw_path: str | Path) -> tuple[pd.DataFrame, bool, str]:
    """Load at most MAX_INGEST_ROWS rows, reporting whether the source had more.

    CSV is capped AT READ TIME (``nrows``) — reading one row past the cap only
    to detect overflow — so a multi-GB export never materializes in memory just
    to be thrown away (mirrors access_logs.py's capped parsers). Parquet is
    loaded via pyarrow and trimmed after; its columnar in-memory form is far
    smaller than the per-row Python structures the cap exists to bound.
    """
    path = Path(raw_path)
    if path.suffix.lower() in (".parquet", ".pq"):
        df = pd.read_parquet(path)  # uses pyarrow
        truncated = len(df) > MAX_INGEST_ROWS
        if truncated:
            df = df.head(MAX_INGEST_ROWS)
        return df, truncated, "parquet"
    try:
        # header=None: S3 Inventory CSVs are HEADERLESS (the column schema lives in
        # the manifest, not the file). Read every row as data; import_inventory_file
        # decides whether row 0 is a header or maps columns by content. +2 rows:
        # one for a possible header line, one to detect overflow past the cap.
        # .tsv really is tab-separated — the composer accepts it, so honor it
        # (a comma read collapses a TSV to one useless column).
        sep = "\t" if ".tsv" in path.name.lower() else ","
        df = pd.read_csv(path, dtype=str, keep_default_na=False, header=None,
                         nrows=MAX_INGEST_ROWS + 2, sep=sep)
    except pd.errors.EmptyDataError:
        # A genuinely empty (0-byte / whitespace-only) CSV is an empty inventory,
        # not a failure. (A headerless file WITH data does not raise this.)
        return pd.DataFrame(), False, "csv"
    # CSV truncation is applied AFTER header handling (import_inventory_file), so
    # the row cap counts DATA rows — a header line never eats a data-row slot.
    return df, False, "csv"


# --- import_inventory_file --------------------------------------------------


def import_inventory_file(raw_path: str | Path, duckdb_path: str | Path) -> dict[str, Any]:
    # The read itself is bounded (no silent cap: a truncated analysis is a lower
    # bound, not the whole object set, and the result says so).
    df_in, truncated, fmt = _load_dataframe(raw_path)
    # CSV columns are integer positions (read headerless). Resolve real names:
    # promote a genuine/synthesized header row, else map columns by content so a
    # raw HEADERLESS S3 inventory export analyzes regardless of column order.
    if fmt == "csv" and len(df_in) > 0:
        if _looks_like_header(df_in.iloc[0]):
            df_in.columns = [str(v) for v in df_in.iloc[0].tolist()]
            df_in = df_in.iloc[1:].reset_index(drop=True)
        else:
            df_in = df_in.rename(
                columns={pos: field for field, pos in _detect_field_columns(df_in).items()})
        # Cap DATA rows now that any header line has been removed (never silent:
        # the result reports truncated + ingest_cap).
        truncated = len(df_in) > MAX_INGEST_ROWS
        if truncated:
            df_in = df_in.head(MAX_INGEST_ROWS)
    norm_map = {_norm(str(c)): c for c in df_in.columns}

    def col_for(field: str) -> str | None:
        for cand in _FIELD_CANDIDATES[field]:
            if cand in norm_map:
                return norm_map[cand]
        return None

    cols = {field: col_for(field) for field in _FIELD_CANDIDATES}

    # Column-wise normalization: builds one Series per target column instead of
    # a list[dict] with one dict per row (which roughly tripled peak memory).
    def series_for(field: str) -> pd.Series:
        c = cols[field]
        if c is None:
            return pd.Series([None] * len(df_in), index=df_in.index, dtype=object)
        return df_in[c]

    # Redact before storing: a key may carry presigned query parameters.
    keys = series_for("key").map(lambda v: redact_text(str(v or "")))
    df = pd.DataFrame({
        "bucket": series_for("bucket"),
        "key": keys,
        "prefix": keys.map(_prefix_of),
        "size": series_for("size").map(_to_int),
        "last_modified": series_for("last_modified").map(_norm_ts),
        "storage_class": series_for("storage_class"),
        "etag": series_for("etag"),
    }, columns=COLUMNS)
    con = duck.connect(duckdb_path)
    try:
        con.register("incoming", df)
        con.execute(f"DROP TABLE IF EXISTS {TABLE_NAME}")
        con.execute(f"CREATE TABLE {TABLE_NAME} AS SELECT * FROM incoming")
        con.unregister("incoming")
        count = con.execute(f"SELECT count(*) FROM {TABLE_NAME}").fetchone()[0]
    finally:
        con.close()
    return {
        "table_name": TABLE_NAME, "row_count": int(count), "format": fmt,
        "truncated": truncated, "ingest_cap": MAX_INGEST_ROWS,
    }


# --- analyze_inventory ------------------------------------------------------

_SIZE_CASE = f"""
CASE
  WHEN size IS NULL THEN 'unknown'
  WHEN size < 4096 THEN '<4KB'
  WHEN size < 131072 THEN '4KB-128KB'
  WHEN size < 1048576 THEN '128KB-1MB'
  WHEN size < 67108864 THEN '1MB-64MB'
  WHEN size < 536870912 THEN '64MB-512MB'
  ELSE '512MB+'
END
"""

_AGE_CASE = """
CASE
  WHEN try_cast(last_modified AS TIMESTAMP) IS NULL THEN 'unknown'
  WHEN datediff('day', try_cast(last_modified AS TIMESTAMP), current_timestamp) <= 7 THEN '0-7d'
  WHEN datediff('day', try_cast(last_modified AS TIMESTAMP), current_timestamp) <= 30 THEN '8-30d'
  WHEN datediff('day', try_cast(last_modified AS TIMESTAMP), current_timestamp) <= 90 THEN '31-90d'
  WHEN datediff('day', try_cast(last_modified AS TIMESTAMP), current_timestamp) <= 180 THEN '91-180d'
  WHEN datediff('day', try_cast(last_modified AS TIMESTAMP), current_timestamp) <= 365 THEN '181-365d'
  ELSE '365d+'
END
"""


def analyze_inventory(duckdb_path: str | Path) -> dict[str, Any]:
    con = duck.connect(duckdb_path, read_only=True)
    try:
        count = con.execute(f"SELECT count(*) FROM {TABLE_NAME}").fetchone()[0]
        if count == 0:
            return {"object_count": 0}

        total_size = con.execute(f"SELECT COALESCE(sum(size), 0) FROM {TABLE_NAME}").fetchone()[0]
        avg_size = con.execute(f"SELECT COALESCE(avg(size), 0) FROM {TABLE_NAME}").fetchone()[0]

        size_hist = [
            {"bucket": b, "count": int(c)}
            for b, c in con.execute(
                f"SELECT {_SIZE_CASE} AS b, count(*) c FROM {TABLE_NAME} GROUP BY b"
            ).fetchall()
        ]
        age_dist = [
            {"bucket": b, "count": int(c)}
            for b, c in con.execute(
                f"SELECT {_AGE_CASE} AS b, count(*) c FROM {TABLE_NAME} GROUP BY b"
            ).fetchall()
        ]
        prefix_dist = [
            {"value": str(p), "count": int(c), "size": int(s or 0)}
            for p, c, s in con.execute(
                f"SELECT prefix, count(*) c, COALESCE(sum(size), 0) s FROM {TABLE_NAME} "
                f"GROUP BY prefix ORDER BY s DESC LIMIT {SAMPLE_LIMIT}"
            ).fetchall()
        ]
        storage_dist = [
            {"value": str(sc), "count": int(c)}
            for sc, c in con.execute(
                f"SELECT storage_class, count(*) c FROM {TABLE_NAME} GROUP BY storage_class ORDER BY c DESC"
            ).fetchall()
        ]
        top_large = [
            {"key": str(k), "size": int(sz or 0), "storage_class": str(sc) if sc is not None else None}
            for k, sz, sc in con.execute(
                f"SELECT key, size, storage_class FROM {TABLE_NAME} "
                f"ORDER BY size DESC NULLS LAST LIMIT {SAMPLE_LIMIT}"
            ).fetchall()
        ]
        small_n = con.execute(
            f"SELECT count(*) FROM {TABLE_NAME} WHERE size IS NOT NULL AND size < {SMALL_OBJECT_BYTES}"
        ).fetchone()[0]
        unknown_age = con.execute(
            f"SELECT count(*) FROM {TABLE_NAME} WHERE try_cast(last_modified AS TIMESTAMP) IS NULL"
        ).fetchone()[0]

        return {
            "object_count": int(count),
            "total_size": int(total_size),
            "average_object_size": int(avg_size),
            "size_histogram": size_hist,
            "prefix_distribution": prefix_dist,
            "object_age_distribution": age_dist,
            "storage_class_distribution": storage_dist,
            "small_object_ratio": round(small_n / count, 4),
            "top_large_objects": top_large,
            "unknown_age_ratio": round(unknown_age / count, 4),
        }
    finally:
        con.close()


# --- findings ---------------------------------------------------------------


def derive_findings(m: dict[str, Any]) -> list[dict[str, str]]:
    f: list[dict[str, str]] = []
    if m.get("object_count", 0) == 0:
        return [{"severity": "warning", "title": "No objects parsed",
                 "detail": "The uploaded inventory produced zero rows."}]

    total_size = m.get("total_size", 0) or 1

    if m["small_object_ratio"] > 0.5:
        f.append({"severity": "warning", "title": "High small-object ratio",
                  "detail": f"{m['small_object_ratio']:.1%} of objects are under 1 MiB; "
                            "many tiny objects can hurt request efficiency and cost."})

    prefixes = m.get("prefix_distribution") or []
    if prefixes and prefixes[0]["size"] / total_size > 0.6:
        f.append({"severity": "info", "title": "Top prefix dominates capacity",
                  "detail": f"Prefix '{prefixes[0]['value']}' holds "
                            f"{prefixes[0]['size'] / total_size:.1%} of total bytes."})

    age = {a["bucket"]: a["count"] for a in m.get("object_age_distribution") or []}
    old = age.get("365d+", 0)
    if old / m["object_count"] > 0.3:
        f.append({"severity": "info", "title": "Lifecycle opportunity",
                  "detail": f"{old / m['object_count']:.1%} of objects are older than 365 days; "
                            "consider a lifecycle/tiering policy (no changes were made)."})

    top_large = m.get("top_large_objects") or []
    large_sum = sum(o["size"] for o in top_large)
    if large_sum / total_size > 0.5:
        f.append({"severity": "info", "title": "Large-object concentration",
                  "detail": f"The {len(top_large)} largest objects hold "
                            f"{large_sum / total_size:.1%} of total bytes."})

    storage = m.get("storage_class_distribution") or []
    if storage and storage[0]["count"] / m["object_count"] > 0.9:
        f.append({"severity": "info", "title": "Storage-class skew",
                  "detail": f"Storage class '{storage[0]['value']}' covers "
                            f"{storage[0]['count'] / m['object_count']:.1%} of objects."})

    if m["unknown_age_ratio"] > 0.2:
        f.append({"severity": "warning", "title": "Missing last_modified",
                  "detail": f"{m['unknown_age_ratio']:.1%} of objects lack a parseable "
                            "last_modified, limiting age analysis."})

    if not f:
        f.append({"severity": "info", "title": "No capacity concerns detected",
                  "detail": "Object size, age, and prefix distributions look balanced."})
    return f
