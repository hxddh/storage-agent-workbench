"""Shared test fixtures.

- Every test gets a fresh data dir (``SAW_DATA_DIR``), database
  (``SAW_DB_PATH``) and secret vault, so nothing touches a real install.
- The runtime and the live hub are process singletons: reset between tests.
"""

from __future__ import annotations

import pytest


def _reset_singletons() -> None:
    from app.agent import models
    from app.agent.runtime import RUNTIME
    from app.core import hub
    from app.security import keyring_store

    keyring_store._reset_for_tests()
    RUNTIME._reset_for_tests()
    hub._reset_for_tests()
    models.NO_PARALLEL.clear()
    models.NO_USAGE.clear()
    models.NO_WEBSOCKET.clear()


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("SAW_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("STORAGE_AGENT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SAW_DB_PATH", str(tmp_path / "db" / "storage-agent.db"))
    _reset_singletons()
    from app.db import init_db
    init_db()
    try:
        yield
    finally:
        _reset_singletons()


@pytest.fixture()
def conn():
    from app.db import connect
    c = connect()
    try:
        yield c
    finally:
        c.close()


@pytest.fixture()
def client():
    """A TestClient over the app (the lifespan runs: migrations, runtime, recovery)."""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c
