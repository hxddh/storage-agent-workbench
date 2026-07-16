"""Tests for the health endpoint."""


def test_health_returns_ok(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "storage-agent-sidecar"
    assert "version" in body  # running service version (metadata or source fallback)
