"""Storage accounts: secrets go into the vault, never out; storage is read-only by construction."""

import sqlite3

from app import config

ACCESS = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
TOKEN = "FwoGZXIvYXdzEXAMPLEsessiontoken"


def _create(client, **overrides):
    body = {"name": "minio-local", "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
            "region": "us-east-1", "addressing_style": "path", "signature_version": "s3v4", "access_key": ACCESS,
            "secret_key": SECRET, "session_token": TOKEN, "allowed_buckets": ["bucket-alpha"],
            "allowed_prefixes": ["logs/", "datasets/"]}
    body.update(overrides)
    return client.post("/providers/clouds", json=body)


def _rows(sql):
    conn = sqlite3.connect(str(config.db_path()))
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


def test_create_returns_flags_never_secrets(client):
    resp = _create(client)
    assert resp.status_code == 201
    data = resp.json()
    assert data["has_access_key"] and data["has_secret_key"] and data["has_session_token"]
    assert "access_key_ref" not in data and "mode" not in data
    assert data["allowed_buckets"] == ["bucket-alpha"]
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in resp.text


def test_secrets_stay_in_the_vault(client):
    data = _create(client).json()
    blob = " ".join(str(c) for r in _rows("SELECT * FROM cloud_providers") for c in r)
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in blob
    assert "keyring://" in blob
    from app.s3 import client_factory
    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    try:
        cfg = client_factory.load_provider(conn, data["id"])
    finally:
        conn.close()
    assert cfg.access_key_ref.startswith("keyring://")


def test_update_scope_and_clear_token(client):
    pid = _create(client).json()["id"]
    resp = client.patch(f"/providers/clouds/{pid}", json={"allowed_prefixes": ["tmp/"], "session_token": ""})
    assert resp.status_code == 200
    assert resp.json()["allowed_prefixes"] == ["tmp/"]
    assert resp.json()["has_session_token"] is False


def test_list_carries_the_watch_and_no_plaintext(client):
    _create(client)
    resp = client.get("/providers/clouds")
    assert resp.status_code == 200
    assert resp.json()[0]["watch"]["enabled"] is False  # the watch is off by default
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in resp.text


def test_delete_removes_secrets(client):
    from app.security import keyring_store
    pid = _create(client).json()["id"]
    refs = [r[0] for r in _rows("SELECT access_key_ref FROM cloud_providers")]
    assert client.delete(f"/providers/clouds/{pid}").status_code == 204
    for ref in refs:
        scope, name = keyring_store.parse_ref(ref)
        assert keyring_store.get_secret(scope, name) is None


def test_audit_has_no_plaintext(client):
    _create(client)
    blob = " ".join(str(r) for r in _rows("SELECT * FROM audit"))
    assert "cloud_provider.create" in blob
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in blob
