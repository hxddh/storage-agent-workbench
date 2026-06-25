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
