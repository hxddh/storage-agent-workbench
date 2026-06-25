"""Tests for cloud provider CRUD and secret handling."""

import sqlite3

from app import config
from app.security import keyring_store

ACCESS = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
TOKEN = "FwoGZXIvYXdzEXAMPLEsessiontoken"


def _create(client, **overrides):
    body = {
        "name": "minio-local",
        "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com",
        "region": "us-east-1",
        "addressing_style": "path",
        "signature_version": "s3v4",
        "access_key": ACCESS,
        "secret_key": SECRET,
        "session_token": TOKEN,
        "mode": "readonly",
        "allowed_buckets": ["bucket-alpha"],
        "allowed_prefixes": ["logs/", "datasets/"],
    }
    body.update(overrides)
    return client.post("/cloud-providers", json=body)


def test_create_defaults_to_readonly_and_no_plaintext(client):
    resp = _create(client)
    assert resp.status_code == 201
    data = resp.json()
    assert data["mode"] == "readonly"
    assert data["has_access_key"] and data["has_secret_key"] and data["has_session_token"]
    assert data["access_key_ref"].startswith("keyring://")
    assert data["allowed_buckets"] == ["bucket-alpha"]
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in resp.text


def test_secrets_not_in_sqlite(client):
    data = _create(client).json()
    conn = sqlite3.connect(str(config.db_path()))
    try:
        row = conn.execute(
            "SELECT * FROM cloud_providers WHERE id = ?", (data["id"],)
        ).fetchone()
    finally:
        conn.close()
    joined = " ".join(str(c) for c in row)
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in joined

    # And the secrets are retrievable from the keyring.
    scope, name = keyring_store.parse_ref(data["access_key_ref"])
    assert keyring_store.get_secret(scope, name) == ACCESS


def test_rejects_invalid_mode(client):
    resp = _create(client, mode="full-write")
    assert resp.status_code == 422  # validation error from Literal type


def test_update_mode_and_prefixes(client):
    provider_id = _create(client).json()["id"]
    resp = client.put(
        f"/cloud-providers/{provider_id}",
        json={"mode": "test-write", "allowed_prefixes": ["tmp/agent-test/"]},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["mode"] == "test-write"
    assert data["allowed_prefixes"] == ["tmp/agent-test/"]


def test_list_has_no_plaintext(client):
    _create(client)
    resp = client.get("/cloud-providers")
    assert resp.status_code == 200
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in resp.text


def test_delete_removes_secrets(client):
    data = _create(client).json()
    provider_id = data["id"]
    refs = [data["access_key_ref"], data["secret_key_ref"], data["session_token_ref"]]

    assert client.delete(f"/cloud-providers/{provider_id}").status_code == 204
    for ref in refs:
        scope, name = keyring_store.parse_ref(ref)
        assert keyring_store.get_secret(scope, name) is None


def test_audit_log_has_no_plaintext(client):
    _create(client)
    conn = sqlite3.connect(str(config.db_path()))
    try:
        rows = conn.execute("SELECT payload_json_sanitized FROM audit_logs").fetchall()
    finally:
        conn.close()
    blob = " ".join(str(r[0]) for r in rows)
    for leaked in (ACCESS, SECRET, TOKEN):
        assert leaked not in blob
