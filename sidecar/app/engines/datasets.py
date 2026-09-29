"""Local datasets (v5): files the user attached and evidence the Agent imported.

Both land under ``<data>/tasks/<task>/datasets/<id>/`` — the raw file and a
DuckDB database — and are analyzed by the same deterministic engines. Raw rows
never reach the model: it sees bounded metrics, findings and whitelisted
aggregates.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any, Iterable

from .. import config
from ..analysis import access_logs, aggregate as agg, inventory
from ..repositories import utcnow
from ..security.redaction import redact, redact_text

MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
TYPES = ("access_log", "inventory")
_SECRETISH = re.compile(r"(AKIA|ASIA)[A-Z0-9]{12,}|[A-Za-z0-9/+]{40}")


def dataset_dir(task_id: str, dataset_id: str) -> Path:
    return config.ensure_secure_dir(config.data_dir() / "tasks" / task_id / "datasets" / dataset_id)


def safe_filename(name: str) -> str:
    base = os.path.basename((name or "").replace("\\", "/")).strip() or "upload"
    base = re.sub(r"[^\w.\-+ ]", "_", base)[:120]
    if base in (".", ".."):
        base = "upload"
    if _SECRETISH.search(base):
        ext = Path(base).suffix[:10]
        base = f"upload-{uuid.uuid4().hex[:8]}{ext}"
    return base


def _row(r: Any) -> dict[str, Any]:
    d = dict(r)
    d["detail"] = json.loads(d["detail"]) if d.get("detail") else {}
    return d


def get(conn: Any, dataset_id: str) -> dict[str, Any] | None:
    r = conn.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone()
    return _row(r) if r else None


def list_for_task(conn: Any, task_id: str) -> list[dict[str, Any]]:
    return [_row(r) for r in conn.execute("SELECT * FROM datasets WHERE task_id = ? ORDER BY created_at",
                                          (task_id,)).fetchall()]


def save_upload(conn: Any, task_id: str, filename: str, dataset_type: str, chunks: Iterable[bytes]) -> dict[str, Any]:
    if dataset_type not in TYPES:
        raise ValueError("dataset_type must be access_log or inventory")
    did = uuid.uuid4().hex
    name = safe_filename(filename)
    raw_dir = config.ensure_secure_dir(dataset_dir(task_id, did) / "raw")
    dest = raw_dir / name
    tmp = raw_dir / f".part-{uuid.uuid4().hex[:8]}"
    size = 0
    try:
        with open(tmp, "wb") as fh:
            for chunk in chunks:
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise ValueError("file is larger than 2 GiB")
                fh.write(chunk)
        os.replace(tmp, dest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        shutil.rmtree(dataset_dir(task_id, did), ignore_errors=True)
        raise
    conn.execute("INSERT INTO datasets (id, task_id, origin, dataset_type, filename, path, size_bytes, status, "
                 "created_at) VALUES (?, ?, 'upload', ?, ?, ?, ?, 'ready', ?)",
                 (did, task_id, dataset_type, redact_text(name), config.rel_path(dest), size, utcnow()))
    conn.commit()
    return get(conn, did)  # type: ignore[return-value]


def register(conn: Any, task_id: str, *, dataset_type: str, filename: str, path: Path, provider_id: str,
             bucket: str, detail: dict[str, Any]) -> dict[str, Any]:
    did = path.parent.parent.name if path.parent.name == "raw" else uuid.uuid4().hex
    conn.execute("INSERT INTO datasets (id, task_id, origin, dataset_type, filename, path, size_bytes, status, "
                 "detail, provider_id, bucket, created_at) VALUES (?, ?, 'import', ?, ?, ?, ?, 'ready', ?, ?, ?, ?)",
                 (did, task_id, dataset_type, redact_text(filename), config.rel_path(path),
                  path.stat().st_size if path.exists() else 0, json.dumps(redact(detail)), provider_id, bucket,
                  utcnow()))
    conn.commit()
    return get(conn, did)  # type: ignore[return-value]


def _abs(rel: str) -> Path:
    p = Path(rel)
    return p if p.is_absolute() else config.data_dir() / p


def duckdb_path(ds: dict[str, Any]) -> Path:
    return _abs(ds["path"]).parent.parent / "data.duckdb"


def ensure_ingested(conn: Any, ds: dict[str, Any]) -> dict[str, Any]:
    """Load the raw file into DuckDB once (bounded; truncation is recorded)."""
    db_file = duckdb_path(ds)
    if ds["status"] == "analyzed" and db_file.exists():
        return ds
    raw = _abs(ds["path"])
    if ds["dataset_type"] == "access_log":
        fmt = access_logs.detect_log_format(raw)
        res = access_logs.import_access_logs(raw, db_file, fmt.get("format", "unknown"))
        detail = {"format": fmt.get("format"), **{k: res.get(k) for k in ("truncated", "ingest_cap")}}
    else:
        res = inventory.import_inventory_file(raw, db_file)
        detail = {k: res.get(k) for k in ("truncated", "ingest_cap", "format")}
    merged = {**(ds.get("detail") or {}), **{k: v for k, v in detail.items() if v is not None}}
    conn.execute("UPDATE datasets SET status = 'analyzed', row_count = ?, detail = ? WHERE id = ?",
                 (int(res.get("row_count") or 0), json.dumps(redact(merged)), ds["id"]))
    conn.commit()
    return get(conn, ds["id"])  # type: ignore[return-value]


def _clamp_lists(metrics: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for k, v in metrics.items():
        if isinstance(v, list):
            out[k] = v[:20]
        elif isinstance(v, dict):
            out[k] = {kk: (vv[:15] if isinstance(vv, list) else vv) for kk, vv in v.items()}
        else:
            out[k] = v
    return out


def analyze(conn: Any, ds: dict[str, Any]) -> dict[str, Any]:
    ds = ensure_ingested(conn, ds)
    db_file = duckdb_path(ds)
    if ds["dataset_type"] == "access_log":
        metrics = access_logs.analyze_access_logs(db_file)
        findings = access_logs.derive_findings(metrics)
    else:
        metrics = inventory.analyze_inventory(db_file)
        findings = inventory.derive_findings(metrics)
    detail = ds.get("detail") or {}
    notes = []
    if detail.get("truncated"):
        notes.append(f"Only the first {detail.get('ingest_cap')} rows were loaded — figures cover a sample, "
                     "say so.")
    if detail.get("format") == "unknown":
        notes.append("The log format was not recognized; some fields may be empty.")
    return {"success": True, "dataset_id": ds["id"], "dataset_type": ds["dataset_type"],
            "filename": ds["filename"], "rows": ds.get("row_count"), "metrics": _clamp_lists(metrics),
            "findings": findings[:30], "notes": notes}


def aggregate(conn: Any, ds: dict[str, Any], *, metric: str, group_by: str | None, group_by_2: str | None,
              filters: dict[str, Any] | None, status_min: int | None, status_max: int | None,
              limit: int) -> dict[str, Any]:
    ds = ensure_ingested(conn, ds)
    res = agg.aggregate(duckdb_path(ds), ds["dataset_type"], metric, group_by=group_by or None,
                        group_by_2=group_by_2 or None, filters=filters or None,
                        status_min=status_min, status_max=status_max, limit=limit)
    res.pop("sql", None)
    res.pop("params", None)
    if (ds.get("detail") or {}).get("truncated"):
        res["coverage_note"] = "The dataset was truncated at ingest; values are lower bounds."
    return {"success": True, "dataset_id": ds["id"], **res}


def allowed_surface() -> dict[str, Any]:
    return agg.allowed_surface()
