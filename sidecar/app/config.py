"""Runtime configuration for the sidecar.

Paths are resolved from environment variables so tests can redirect the
database to a temporary location without touching real app data.
"""

from __future__ import annotations

import os
from pathlib import Path

# Repo root is two levels up from this file: <repo>/sidecar/app/config.py
_REPO_ROOT = Path(__file__).resolve().parents[2]


def data_dir() -> Path:
    """Directory for local app data (database, run artifacts)."""
    override = os.environ.get("SAW_DATA_DIR")
    if override:
        return Path(override)
    return _REPO_ROOT / "data"


def db_path() -> Path:
    """Filesystem path to the SQLite database."""
    override = os.environ.get("SAW_DB_PATH")
    if override:
        return Path(override)
    return data_dir() / "app.db"


def run_dir(run_id: str) -> Path:
    """Per-run artifact directory: data/runs/{run_id}/."""
    return data_dir() / "runs" / run_id


def rel_path(path: str | Path) -> str:
    """Return a path relative to the data dir for safe logging.

    Avoids recording absolute paths (which may contain a username) in
    tool_calls / audit_logs. Falls back to just the filename if the path is
    outside the data dir.
    """
    p = Path(path)
    base = data_dir()
    try:
        return str(p.relative_to(base))
    except ValueError:
        return p.name
