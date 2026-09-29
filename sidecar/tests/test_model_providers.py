"""Model endpoints: the key goes into the vault and never comes out; one is active;
the API style follows the endpoint (Responses only on the official OpenAI host)."""

import sqlite3

import pytest

from app import config

SECRET = "sk-super-secret-model-key-DO-NOT-LEAK"


def _create(client, **overrides):
    body = {"name": "OpenAI prod", "kind": "openai", "base_url": "https://api.openai.com/v1", "model": "gpt-5",
            "api_key": SECRET}
    body.update(overrides)
    return client.post("/providers/models", json=body)


class _Resp:
    def __init__(self, status_code: int):
        self.status_code = status_code


def test_create_returns_no_secret(client):
    resp = _create(client)
    assert resp.status_code == 201
    data = resp.json()
    assert data["has_api_key"] is True and data["active"] is True
    assert "api_key" not in data and "api_key_ref" not in data
    assert SECRET not in resp.text


def test_secret_not_in_sqlite(client):
    _create(client)
    conn = sqlite3.connect(str(config.db_path()))
    try:
        row = conn.execute("SELECT * FROM model_providers").fetchone()
    finally:
        conn.close()
    assert SECRET not in " ".join(str(c) for c in row)
    assert "keyring://" in " ".join(str(c) for c in row)


@pytest.mark.parametrize("kind,base_url,style", [
    ("openai", "https://api.openai.com/v1", "responses"),
    ("openai", None, "responses"),
    ("openai", "https://gateway.example.com/v1", "chat"),
    ("deepseek", None, "chat"),
    ("ollama", None, "chat"),
])
def test_api_style_follows_the_endpoint(client, kind, base_url, style):
    body = {"kind": kind, "base_url": base_url}
    if kind == "ollama":
        body["api_key"] = None
    assert _create(client, **body).json()["api_style"] == style


def test_one_active_and_activation_moves(client):
    a = _create(client, name="a").json()
    b = _create(client, name="b").json()
    assert a["active"] and not b["active"]
    client.post(f"/providers/models/{b['id']}/activate")
    listed = {p["id"]: p["active"] for p in client.get("/providers/models").json()}
    assert listed == {a["id"]: False, b["id"]: True}
    assert client.delete(f"/providers/models/{b['id']}").status_code == 204
    assert client.get("/providers/models").json()[0]["active"] is True  # the next one takes over


def test_patch_rotates_key_without_echo(client):
    pid = _create(client).json()["id"]
    resp = client.patch(f"/providers/models/{pid}", json={"api_key": "sk-rotated-XYZ", "name": "renamed"})
    assert resp.status_code == 200 and resp.json()["name"] == "renamed"
    assert "sk-rotated-XYZ" not in resp.text


def test_validation_error_never_echoes_the_key(client):
    resp = client.post("/providers/models", json={"kind": "openai", "api_key": SECRET})
    assert resp.status_code == 422
    assert SECRET not in resp.text


@pytest.mark.parametrize("code,ok,verified", [(200, True, True), (401, False, False), (404, True, None),
                                               (503, False, None)])
def test_probe(client, monkeypatch, code, ok, verified):
    import httpx2
    pid = _create(client).json()["id"]
    seen = {}

    def fake_get(url, headers=None, timeout=None):
        seen["url"], seen["auth"] = url, (headers or {}).get("Authorization", "")
        return _Resp(code)

    monkeypatch.setattr(httpx2, "get", fake_get)
    resp = client.post(f"/providers/models/{pid}/test")
    body = resp.json()
    assert (body["ok"], body["api_key_verified"]) == (ok, verified)
    assert seen["url"].endswith("/models") and SECRET in seen["auth"]
    assert SECRET not in resp.text


def test_probe_unreachable(client, monkeypatch):
    import httpx2

    def boom(*a, **k):
        raise httpx2.ConnectError("no route")

    pid = _create(client).json()["id"]
    monkeypatch.setattr(httpx2, "get", boom)
    body = client.post(f"/providers/models/{pid}/test").json()
    assert body["ok"] is False and "reach" in body["detail"]
