"""Access-log analysis tools.

Reads a user-uploaded local access-log file, normalizes it into a DuckDB
``access_logs`` table, and computes metrics. Client IPs are masked and any
credential-shaped values are redacted before anything is persisted. No object
bodies are downloaded; this operates purely on the uploaded file.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from ..security.redaction import mask_ip, redact_text
from . import duck

TABLE_NAME = "access_logs"
SAMPLE_LIMIT = 20
# Bound how many rows a single ingest materializes in memory. The parsers build a
# list[dict] and hand it to DuckDB; without a cap a multi-GB log would OOM the
# sidecar. Rows beyond this are dropped and the result is flagged truncated. Large
# datasets belong in a proper inventory/analysis run, not the in-memory parser.
MAX_INGEST_ROWS = 2_000_000

COLUMNS = [
    "timestamp", "method", "key", "path", "prefix", "status_code",
    "bytes_sent", "latency_ms", "user_agent", "client_ip_masked",
    "request_id", "error_code", "raw_sanitized",
]

# App / example format:
#   2026-06-25T10:00:00Z bucket-alpha GET /path 206 1048576 42 ms user-agent="..." remote_ip="192.0.2.10"
_TEXT_RE = re.compile(
    r'^(?P<ts>\S+)\s+(?P<bucket>\S+)\s+(?P<method>[A-Z]+)\s+(?P<path>\S+)\s+'
    r'(?P<status>\d{3})\s+(?P<bytes>\d+)\s+(?P<latency>\d+)\s*ms\s+'
    r'user-agent="(?P<ua>[^"]*)"\s+remote_ip="(?P<ip>[^"]*)"'
)
# Common / combined log format.
_CLF_RE = re.compile(
    r'^(?P<ip>\S+)\s+\S+\s+\S+\s+\[(?P<ts>[^\]]+)\]\s+'
    r'"(?P<method>[A-Z]+)\s+(?P<path>\S+)[^"]*"\s+(?P<status>\d{3})\s+(?P<bytes>\S+)'
    r'(?:\s+"[^"]*"\s+"(?P<ua>[^"]*)")?'
)


# --- helpers ----------------------------------------------------------------


def _prefix_of(key: str) -> str:
    key = (key or "").lstrip("/")
    return key.split("/", 1)[0] + "/" if "/" in key else "(root)"


def _to_int(value: Any) -> int | None:
    try:
        if value in (None, "", "-"):
            return None
        s = str(value).strip()
        # Parse as an integer directly so int64 values > 2^53 don't lose
        # precision through a float round-trip; fall back to float for genuinely
        # fractional strings (e.g. a latency "12.5").
        try:
            return int(s)
        except ValueError:
            return int(float(s))
    except (TypeError, ValueError):
        return None


def _normalize_ts(ts: Any) -> str | None:
    """Normalize a log timestamp to a canonical naive-UTC ISO-8601 string.

    Both the CLF/combined format (``25/Jun/2026:10:00:00 +0000``) and tz-aware
    ISO-8601 are converted to UTC wall-clock, so DuckDB ``try_cast(... AS
    TIMESTAMP)`` succeeds and hour-bucketing is correct and timezone-consistent
    (previously CLF timestamps cast to NULL → every hour bucket was 'unknown',
    and tz offsets were silently dropped → events bucketed by local wall-clock).
    Unrecognized values are returned unchanged (downstream still yields 'unknown').
    """
    if ts is None:
        return None
    s = str(ts).strip()
    if not s:
        return None
    epoch = _epoch_to_iso(s)
    if epoch is not None:
        return epoch
    for fmt in ("%d/%b/%Y:%H:%M:%S %z", "%d/%b/%Y:%H:%M:%S"):
        try:
            return _to_utc_iso(datetime.strptime(s, fmt))
        except ValueError:
            pass
    try:
        return _to_utc_iso(datetime.fromisoformat(s.replace("Z", "+00:00")))
    except ValueError:
        return s


# A bare numeric timestamp is a Unix epoch — common in JSON / CDN / some
# S3-compatible access logs. Without this, such values fail every text format
# above and cast to NULL downstream, so every hour bucket becomes 'unknown' and
# the log's whole time analysis silently vanishes. The unit (s / ms / µs / ns) is
# inferred by magnitude. The integer part must be 10–21 digits so small integers
# (ports, status codes, sizes) are never misread as timestamps: a 10-digit second
# epoch starts at 2001-09-09, which is a safe floor for real access logs.
_EPOCH_RE = re.compile(r"^\d{10,21}(?:\.\d+)?$")


def _epoch_to_iso(s: str) -> str | None:
    if not _EPOCH_RE.match(s):
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if v >= 1e18:      # nanoseconds
        v /= 1e9
    elif v >= 1e15:    # microseconds
        v /= 1e6
    elif v >= 1e12:    # milliseconds
        v /= 1e3
    # else: seconds
    try:
        return _to_utc_iso(datetime.fromtimestamp(v, tz=timezone.utc))
    except (OverflowError, OSError, ValueError):
        return None


def _to_utc_iso(dt: datetime) -> str:
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def _row(ts, method, path, status, nbytes, latency, ua, ip, request_id, raw) -> dict[str, Any]:
    # Redact BEFORE anything is stored in DuckDB: a path/key may carry presigned
    # query params and a user-agent may carry a bearer token.
    path = redact_text(str(path)) if path is not None else None
    ua = redact_text(str(ua)) if ua is not None else None
    key = (path or "").lstrip("/")
    return {
        "timestamp": _normalize_ts(ts),
        "method": method,
        "key": key,
        "path": path,
        "prefix": _prefix_of(key),
        "status_code": _to_int(status),
        "bytes_sent": _to_int(nbytes),
        "latency_ms": _to_int(latency),
        "user_agent": ua,
        "client_ip_masked": mask_ip(ip),
        "request_id": request_id,
        "error_code": None,
        "raw_sanitized": redact_text(raw)[:500] if raw else None,
    }


def _open_text(path: str | Path):
    """Open a log file as text, transparently gunzipping ``.gz`` — the composer
    accepts gzipped logs, and reading them as raw bytes previously produced
    mojibake rows and a misleadingly clean 'no anomalies' analysis."""
    import gzip
    p = Path(path)
    if p.name.lower().endswith(".gz"):
        return gzip.open(p, "rt", encoding="utf-8", errors="replace")
    return open(p, "r", encoding="utf-8", errors="replace")


def _nonempty_lines(path: str | Path, limit: int | None = None) -> list[str]:
    out: list[str] = []
    with _open_text(path) as fh:
        for line in fh:
            s = line.strip()
            if not s:
                continue
            out.append(s)
            if limit and len(out) >= limit:
                break
    return out


# --- tool 1: detect_log_format ----------------------------------------------


# CSV header cells the _parse_csv column picker (pick(...) below) recognizes.
# The detector MUST stay in sync with the parser: a valid CSV access log whose
# header isn't recognized is detected "unknown", then ingested by the universal
# text parser as raw null-field rows — yielding a misleadingly clean "no
# anomalies" analysis of a log that simply wasn't parsed. Keep this set == the
# union of pick() candidates.
_CSV_HEADER_TOKENS = frozenset({
    "timestamp", "time", "ts", "method", "verb", "path", "key", "uri", "request",
    "status", "status_code", "bytes", "bytes_sent", "size", "latency_ms",
    "latency", "duration_ms", "user_agent", "ua", "remote_ip", "client_ip", "ip",
    "request_id", "req_id",
})


def detect_log_format(path: str | Path) -> dict[str, Any]:
    sample = _nonempty_lines(path, limit=20)
    fmt = "unknown"
    if sample:
        first = sample[0]
        if first.startswith("{"):
            try:
                json.loads(first)
                fmt = "jsonl"
            except json.JSONDecodeError:
                fmt = "unknown"
        if fmt == "unknown" and (_TEXT_RE.match(first) or _CLF_RE.match(first)):
            fmt = "text"
        if fmt == "unknown" and ("," in first or "\t" in first):
            # CSV/TSV header: at least one delimited cell EXACTLY matches a
            # column the parser understands (exact match, like pick() — not a
            # substring test, so short tokens like "ip"/"ts" can't false-positive
            # on arbitrary prose). Tab wins when present (a TSV header contains
            # no commas).
            delim = "\t" if "\t" in first else ","
            cells = {c.strip().lower() for c in first.split(delim)}
            if cells & _CSV_HEADER_TOKENS:
                fmt = "csv"
    return {"format": fmt, "sampled_lines": len(sample)}


# --- parsers ----------------------------------------------------------------


def _parse_jsonl(path: str | Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in _nonempty_lines(path, limit=MAX_INGEST_ROWS):
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        rows.append(_row(
            o.get("timestamp") or o.get("time") or o.get("ts"),
            o.get("method") or o.get("verb"),
            o.get("path") or o.get("key") or o.get("uri") or o.get("request"),
            o.get("status") or o.get("status_code"),
            o.get("bytes") or o.get("bytes_sent") or o.get("size"),
            o.get("latency_ms") or o.get("latency") or o.get("duration_ms"),
            o.get("user_agent") or o.get("ua"),
            o.get("remote_ip") or o.get("client_ip") or o.get("ip"),
            o.get("request_id") or o.get("req_id"),
            line,
        ))
    return rows


def _parse_text(path: str | Path) -> list[dict[str, Any]]:
    """Parse a text log. Known formats (app/S3 + CLF) are structured; any other
    non-empty line is still INGESTED as a raw row (no structured fields) so a
    generic .log/.txt yields a usable dataset instead of an empty result or a
    crash. Always redacted before storage."""
    rows: list[dict[str, Any]] = []
    for line in _nonempty_lines(path, limit=MAX_INGEST_ROWS):
        m = _TEXT_RE.match(line) or _CLF_RE.match(line)
        if m:
            g = m.groupdict()
            rows.append(_row(
                g.get("ts"), g.get("method"), g.get("path"), g.get("status"),
                g.get("bytes"), g.get("latency"), g.get("ua"), g.get("ip"), None, line,
            ))
        else:
            # Unrecognized line: keep it as a raw (redacted) row, no fake fields.
            rows.append(_row(None, None, None, None, None, None, None, None, None, line))
    return rows


def _parse_csv(path: str | Path) -> list[dict[str, Any]]:
    # Robust + never-crash: the python engine tolerates ragged rows, on_bad_lines
    # skips malformed ones instead of raising a C tokenizer error. Try explicit
    # delimiters in order (comma, then tab) rather than sep=None — the csv.Sniffer
    # raises "Could not determine delimiter" on ambiguous/single-column files,
    # which previously dropped a valid comma CSV to the null-field text fallback.
    # Try the MORE LIKELY delimiter first: if the header line contains a tab it's
    # a TSV — try tab before comma. This matches detect_log_format's choice
    # (`"\t" if "\t" in first else ","`), so parser and detector never disagree,
    # and it prevents the early-break below from locking onto a comma that merely
    # lives INSIDE a TSV header cell (which would split the header into 2 junk
    # columns and null every request field).
    header = _nonempty_lines(path, limit=1)
    seps = ("\t", ",") if header and "\t" in header[0] else (",", "\t")
    df = None
    for sep in seps:
        try:
            cand = pd.read_csv(path, dtype=str, keep_default_na=False, sep=sep,
                               engine="python", on_bad_lines="skip", nrows=MAX_INGEST_ROWS)
        except Exception:  # noqa: BLE001
            continue
        # A wrong delimiter collapses everything into one column; prefer the sep
        # that actually splits the header into recognized fields.
        if df is None or len(cand.columns) > len(df.columns):
            df = cand
        # Early exit: if this delimiter already split the header into a recognized
        # column, it's the right one — stop before re-reading (and re-decompressing
        # a .gz) the whole file with the next candidate delimiter.
        cells = {str(c).strip().lower() for c in cand.columns}
        if len(cand.columns) > 1 and cells & _CSV_HEADER_TOKENS:
            break
    if df is None:
        return []
    lower = {c.lower().strip(): c for c in df.columns}

    def pick(*cands: str):
        for c in cands:
            if c in lower:
                return lower[c]
        return None

    col_ts = pick("timestamp", "time", "ts")
    col_method = pick("method", "verb")
    col_path = pick("path", "key", "uri", "request")
    col_status = pick("status", "status_code")
    col_bytes = pick("bytes", "bytes_sent", "size")
    col_latency = pick("latency_ms", "latency", "duration_ms")
    col_ua = pick("user_agent", "ua")
    col_ip = pick("remote_ip", "client_ip", "ip")
    col_rid = pick("request_id", "req_id")

    rows: list[dict[str, Any]] = []
    for _, r in df.iterrows():
        def val(col):
            return r[col] if col else None
        rows.append(_row(
            val(col_ts), val(col_method), val(col_path), val(col_status),
            val(col_bytes), val(col_latency), val(col_ua), val(col_ip),
            val(col_rid), None,
        ))
    return rows


# --- tool 2: import_access_logs ---------------------------------------------


def import_access_logs(raw_path: str | Path, duckdb_path: str | Path, fmt: str) -> dict[str, Any]:
    if fmt == "jsonl":
        rows = _parse_jsonl(raw_path) or _parse_csv(raw_path) or _parse_text(raw_path)
    elif fmt == "csv":
        rows = _parse_csv(raw_path) or _parse_jsonl(raw_path) or _parse_text(raw_path)
    else:  # "text" and fallback — _parse_text ingests any non-empty line
        rows = _parse_text(raw_path) or _parse_jsonl(raw_path) or _parse_csv(raw_path)

    if not rows:
        # Only reachable for an effectively empty input (no non-blank lines).
        # Raise a clear, friendly message instead of producing an empty table or
        # letting a downstream parser exception surface as a cryptic crash.
        raise ValueError(
            "No log lines could be read from this file. It appears to be empty or "
            "contains no usable text. Supported inputs: plain-text access logs "
            "(.log/.txt), CLF/combined, CSV, or JSON lines."
        )

    # The parsers cap at MAX_INGEST_ROWS; if we're at the cap, the source almost
    # certainly had more. Report it (no silent cap) so the analysis is presented
    # as a lower bound, not the whole log. (The universal text fallback ingests
    # one row per line, so `== cap` is exact there; jsonl/csv may skip malformed
    # lines, making this a conservative best-effort signal.)
    truncated = len(rows) >= MAX_INGEST_ROWS

    df = pd.DataFrame(rows, columns=COLUMNS)
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


# --- tool 3: analyze_access_logs --------------------------------------------


def _dist(con, sql: str) -> list[dict[str, Any]]:
    return [{"value": str(v), "count": int(c)} for v, c in con.execute(sql).fetchall()]


def analyze_access_logs(duckdb_path: str | Path) -> dict[str, Any]:
    con = duck.connect(duckdb_path, read_only=True)
    try:
        total = con.execute(f"SELECT count(*) FROM {TABLE_NAME}").fetchone()[0]
        if total == 0:
            return {"total_requests": 0}

        def rate(lo: int, hi: int) -> float:
            n = con.execute(
                f"SELECT count(*) FROM {TABLE_NAME} WHERE status_code >= {lo} AND status_code <= {hi}"
            ).fetchone()[0]
            return round(n / total, 4)

        status_dist = _dist(con, f"SELECT status_code, count(*) c FROM {TABLE_NAME} GROUP BY status_code ORDER BY c DESC")
        method_dist = _dist(con, f"SELECT method, count(*) c FROM {TABLE_NAME} GROUP BY method ORDER BY c DESC")
        by_hour = [
            {"hour": str(h), "count": int(c)}
            for h, c in con.execute(
                f"SELECT CASE WHEN try_cast(timestamp AS TIMESTAMP) IS NULL THEN 'unknown' "
                f"ELSE strftime(try_cast(timestamp AS TIMESTAMP), '%Y-%m-%dT%H:00') END AS hour, "
                f"count(*) c FROM {TABLE_NAME} GROUP BY hour ORDER BY hour"
            ).fetchall()
        ]
        top_keys = _dist(con, f"SELECT key, count(*) c FROM {TABLE_NAME} GROUP BY key ORDER BY c DESC LIMIT {SAMPLE_LIMIT}")
        top_prefixes = _dist(con, f"SELECT prefix, count(*) c FROM {TABLE_NAME} GROUP BY prefix ORDER BY c DESC LIMIT {SAMPLE_LIMIT}")
        top_uas = _dist(con, f"SELECT user_agent, count(*) c FROM {TABLE_NAME} GROUP BY user_agent ORDER BY c DESC LIMIT {SAMPLE_LIMIT}")

        n_206 = con.execute(f"SELECT count(*) FROM {TABLE_NAME} WHERE status_code = 206").fetchone()[0]
        n_404 = con.execute(f"SELECT count(*) FROM {TABLE_NAME} WHERE status_code = 404").fetchone()[0]
        n_403 = con.execute(f"SELECT count(*) FROM {TABLE_NAME} WHERE status_code = 403").fetchone()[0]
        # How much of the log actually PARSED into structured requests. The
        # universal text fallback ingests unrecognized lines as raw rows with
        # null fields — without this signal a fully-unparsed log reads as
        # "0% errors" (clean) when the truth is "nothing was parsed".
        n_parsed = con.execute(
            f"SELECT count(*) FROM {TABLE_NAME} WHERE status_code IS NOT NULL "
            f"OR method IS NOT NULL"
        ).fetchone()[0]

        return {
            "total_requests": int(total),
            "parsed_fraction": round(n_parsed / total, 4),
            "status_code_distribution": status_dist,
            "method_distribution": method_dist,
            "requests_by_hour": by_hour,
            "top_keys": top_keys,
            "top_prefixes": top_prefixes,
            "top_user_agents": top_uas,
            "error_rate_4xx": rate(400, 499),
            "error_rate_5xx": rate(500, 599),
            "range_share_206": round(n_206 / total, 4),
            "share_404": round(n_404 / total, 4),
            "share_403": round(n_403 / total, 4),
        }
    finally:
        con.close()


# --- findings ---------------------------------------------------------------


def derive_findings(m: dict[str, Any]) -> list[dict[str, str]]:
    f: list[dict[str, str]] = []
    total = m.get("total_requests", 0)
    if total == 0:
        return [{"severity": "warning", "title": "No requests parsed",
                 "detail": "The uploaded log produced zero recognizable request rows."}]

    # TRUTH GUARD: a log that mostly didn't parse must not be narrated as clean.
    # Without this, a fully-unstructured .log read "0% errors" and even fired
    # "hot key" findings on the null group. Low parsed fraction → lead with the
    # honest warning and suppress every metric-derived finding (the metrics are
    # about the parsed sliver, not the log).
    parsed = m.get("parsed_fraction")
    if parsed is not None and parsed < 0.5:
        return [{
            "severity": "warning", "title": "Log mostly unparsed",
            "detail": (f"Only {parsed:.0%} of {total} ingested lines parsed into "
                       "structured requests — error rates and access patterns below "
                       "reflect that sliver, not the whole log. The format may be "
                       "unsupported; share a sample line to identify it."),
        }]

    if m["error_rate_4xx"] > 0.10:
        f.append({"severity": "warning", "title": "High 4xx error rate",
                  "detail": f"4xx responses are {m['error_rate_4xx']:.1%} of requests."})
    if m["error_rate_5xx"] > 0.05:
        f.append({"severity": "error", "title": "High 5xx error rate",
                  "detail": f"5xx responses are {m['error_rate_5xx']:.1%} of requests."})
    if m["share_404"] > 0.20:
        f.append({"severity": "warning", "title": "Suspicious 404 pattern",
                  "detail": f"404 responses are {m['share_404']:.1%} of requests."})
    if m["share_403"] > 0.20:
        f.append({"severity": "warning", "title": "Suspicious 403 pattern",
                  "detail": f"403 responses are {m['share_403']:.1%} of requests."})

    # Concentration findings need a real signal: never fire on the null group
    # (unparsed rows all share key=None) and not on a sample too small for
    # "concentration" to mean anything.
    _MIN_CONCENTRATION_ROWS = 50

    def _real_group(entry: dict[str, Any]) -> bool:
        return entry.get("value") not in (None, "None", "")

    top_keys = m.get("top_keys") or []
    if (total >= _MIN_CONCENTRATION_ROWS and top_keys and _real_group(top_keys[0])
            and top_keys[0]["count"] / total > 0.5):
        f.append({"severity": "info", "title": "Concentrated hot key",
                  "detail": f"Top key accounts for {top_keys[0]['count']} of {total} requests."})
    top_pref = m.get("top_prefixes") or []
    if (total >= _MIN_CONCENTRATION_ROWS and top_pref and _real_group(top_pref[0])
            and top_pref[0]["count"] / total > 0.7):
        f.append({"severity": "info", "title": "Concentrated hot prefix",
                  "detail": f"Top prefix '{top_pref[0]['value']}' dominates request volume."})
    if m["range_share_206"] > 0.30:
        f.append({"severity": "info", "title": "Range-like workload",
                  "detail": f"206 Partial Content responses are {m['range_share_206']:.1%} of requests."})

    if not f:
        f.append({"severity": "info", "title": "No anomalies detected",
                  "detail": "Error rates and access concentration are within normal thresholds."})
    return f
