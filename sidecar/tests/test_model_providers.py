"""Tests for model provider CRUD and secret handling."""

import sqlite3

from app import config
from app.security import keyring_store

SECRET = "sk-super-secret-model-key-DO-NOT-LEAK"


def _create(client, **overrides):
    body = {
        "name": "OpenAI prod",
        "provider_type": "openai",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o",
        "api_key": SECRET,
    }
    body.update(overrides)
    return client.post("/model-providers", json=body)


def test_create_returns_no_plaintext_secret(client):
    resp = _create(client)
    assert resp.status_code == 201
    data = resp.json()
    assert data["has_api_key"] is True
    assert data["api_key_ref"].startswith("keyring://")
    # No plaintext secret anywhere in the response.
    assert SECRET not in resp.text
    assert "api_key" not in data  # only the ref is exposed


def test_secret_not_in_sqlite_but_in_keyring(client):
    data = _create(client).json()
    provider_id = data["id"]

    # Inspect the raw DB row: it must contain the ref, never the plaintext.
    conn = sqlite3.connect(str(config.db_path()))
    try:
        row = conn.execute(
            "SELECT * FROM model_providers WHERE id = ?", (provider_id,)
        ).fetchone()
    finally:
        conn.close()
    assert row is not None
    assert SECRET not in " ".join(str(c) for c in row)

    # The secret really lives in the keyring.
    scope, name = keyring_store.parse_ref(data["api_key_ref"])
    assert keyring_store.get_secret(scope, name) == SECRET


def test_has_api_key_false_when_secret_absent_despite_ref(client):
    """A provider whose secret is gone from the vault (e.g. after the
    keychain→vault migration) must report has_api_key False so the user knows to
    re-enter it — not stay True just because the ref column survives."""
    data = _create(client).json()
    scope, name = keyring_store.parse_ref(data["api_key_ref"])
    keyring_store.delete_secret(scope, name)  # simulate the un-migrated secret
    listed = client.get("/model-providers").json()
    match = next(p for p in listed if p["id"] == data["id"])
    assert match["api_key_ref"] is not None  # ref still in SQLite
    assert match["has_api_key"] is False     # but flagged as missing


def test_list_and_get_consistency(client):
    _create(client, name="A")
    _create(client, name="B")
    resp = client.get("/model-providers")
    assert resp.status_code == 200
    names = {p["name"] for p in resp.json()}
    assert {"A", "B"} <= names
    assert SECRET not in resp.text


def test_update_rotates_secret_without_echo(client):
    provider_id = _create(client).json()["id"]
    resp = client.put(
        f"/model-providers/{provider_id}",
        json={"model": "gpt-4o-mini", "api_key": "sk-rotated-secret"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["model"] == "gpt-4o-mini"
    assert "sk-rotated-secret" not in resp.text
    scope, name = keyring_store.parse_ref(data["api_key_ref"])
    assert keyring_store.get_secret(scope, name) == "sk-rotated-secret"


def test_update_keeps_secret_when_omitted(client):
    provider_id = _create(client).json()["id"]
    resp = client.put(f"/model-providers/{provider_id}", json={"name": "renamed"})
    assert resp.status_code == 200
    scope, name = keyring_store.parse_ref(resp.json()["api_key_ref"])
    assert keyring_store.get_secret(scope, name) == SECRET


def test_delete_removes_row_and_secret(client):
    data = _create(client).json()
    provider_id = data["id"]
    scope, name = keyring_store.parse_ref(data["api_key_ref"])

    resp = client.delete(f"/model-providers/{provider_id}")
    assert resp.status_code == 204
    assert client.get("/model-providers").json() == []
    assert keyring_store.get_secret(scope, name) is None


def test_delete_missing_returns_404(client):
    assert client.delete("/model-providers/nope").status_code == 404


class _FakeResp:
    def __init__(self, status_code: int):
        self.status_code = status_code


def test_test_endpoint_reports_complete(client, monkeypatch):
    import httpx

    provider_id = _create(client).json()["id"]
    seen = {}

    def fake_get(url, headers=None, timeout=None):
        seen["url"] = url
        seen["auth"] = (headers or {}).get("Authorization", "")
        return _FakeResp(200)

    monkeypatch.setattr(httpx, "get", fake_get)
    resp = client.post(f"/model-providers/{provider_id}/test")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["checks"]["api_key_present"] is True
    assert body["api_key_verified"] is True
    assert body["checks"]["endpoint_reachable"] is True
    # The probe hit the provider's /models with the key — but the secret never
    # appears in the RESPONSE.
    assert seen["url"].endswith("/models") and SECRET in seen["auth"]
    assert SECRET not in resp.text


def test_test_endpoint_flags_rejected_key(client, monkeypatch):
    import httpx

    provider_id = _create(client).json()["id"]
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _FakeResp(401))
    body = client.post(f"/model-providers/{provider_id}/test").json()
    assert body["ok"] is False
    assert body["api_key_verified"] is False


def test_test_endpoint_unreachable_is_reported(client, monkeypatch):
    import httpx

    def boom(*a, **k):
        raise httpx.ConnectError("no route")

    provider_id = _create(client).json()["id"]
    monkeypatch.setattr(httpx, "get", boom)
    body = client.post(f"/model-providers/{provider_id}/test").json()
    assert body["ok"] is False
    assert body["checks"]["endpoint_reachable"] is False


def test_test_endpoint_5xx_is_not_ok(client, monkeypatch):
    import httpx

    provider_id = _create(client).json()["id"]
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _FakeResp(503))
    body = client.post(f"/model-providers/{provider_id}/test").json()
    # Reachable but 5xx must NOT pass the test (detail said "server error").
    assert body["ok"] is False
    assert body["checks"]["server_error"] is True


def test_test_endpoint_no_models_endpoint_is_reachable_unverified(client, monkeypatch):
    import httpx

    provider_id = _create(client).json()["id"]
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _FakeResp(404))
    body = client.post(f"/model-providers/{provider_id}/test").json()
    # Endpoint answered (reachable); key neither proven nor disproven → ok.
    assert body["ok"] is True
    assert body["checks"]["endpoint_reachable"] is True
    assert "api_key_accepted" not in body["checks"]
