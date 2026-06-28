"""Shared test fixtures.

- Installs an in-memory keyring backend so tests never touch the real OS
  Keychain and run on CI without a Secret Service / dbus.
- Points each test at a fresh temporary SQLite database via ``SAW_DB_PATH``.
"""

from __future__ import annotations

import keyring
import pytest
from keyring.backend import KeyringBackend


class InMemoryKeyring(KeyringBackend):
    """Volatile keyring backend for tests."""

    priority = 1  # type: ignore[assignment]

    def __init__(self) -> None:
        super().__init__()
        self._store: dict[tuple[str, str], str] = {}

    def get_password(self, service, username):
        return self._store.get((service, username))

    def set_password(self, service, username, password):
        self._store[(service, username)] = password

    def delete_password(self, service, username):
        try:
            del self._store[(service, username)]
        except KeyError as exc:  # pragma: no cover - mirrors backend contract
            raise keyring.errors.PasswordDeleteError("not found") from exc


@pytest.fixture(autouse=True)
def _in_memory_keyring():
    from app.security import keyring_store

    backend = InMemoryKeyring()
    previous = keyring.get_keyring()
    keyring.set_keyring(backend)
    # The store mirrors the consolidated secret map in-process; reset it around
    # each test so a fresh in-memory backend is never shadowed by cached state.
    keyring_store._reset_for_tests()
    try:
        yield backend
    finally:
        keyring.set_keyring(previous)
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
