"""Shared test fixtures.

- Points the encrypted secret vault at a fresh temp data dir per test (via
  ``SAW_DATA_DIR``) so tests never touch a real user's vault and stay isolated.
- The ``client`` fixture overrides ``SAW_DATA_DIR``/``SAW_DB_PATH`` with its own
  temp dir; it runs after the autouse fixture below, so its paths win.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _secret_vault(tmp_path, monkeypatch):
    """Isolate the encrypted secret vault to a per-test temp directory."""
    from app.security import keyring_store

    monkeypatch.setenv("SAW_DATA_DIR", str(tmp_path / "vault"))
    keyring_store._reset_for_tests()
    try:
        yield
    finally:
        keyring_store._reset_for_tests()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """A TestClient bound to a fresh temp database (lifespan runs migrations)."""
    from fastapi.testclient import TestClient

    monkeypatch.setenv("SAW_DB_PATH", str(tmp_path / "test_app.db"))
    # Keep generated artifacts (run reports) inside the temp dir, not the repo.
    monkeypatch.setenv("SAW_DATA_DIR", str(tmp_path))

    from app.main import app

    with TestClient(app) as c:
        yield c
