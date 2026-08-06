"""v0.63.0 — a server fault must reach the UI as a server fault.

An unhandled exception escaped as a bare ASGI error, produced outside
``CORSMiddleware``. The browser saw a cross-origin response with no
``Access-Control-Allow-Origin``, so `fetch` rejected with
``TypeError: Failed to fetch`` and the thread rendered "Couldn't load this
session — TypeError: Failed to fetch". A 500 on ``GET /sessions/{id}`` therefore
read, for several releases, as "the sidecar is unreachable" — pointing every
diagnosis at the wrong layer.

The response says which exception type, and nothing else. An exception message
can quote the request that produced it, and this is the one response shape that
is reached by definition without having been reasoned about, so it gets the
narrowest body that is still useful.
"""
from __future__ import annotations

import pytest
from fastapi import APIRouter

ORIGIN = "http://localhost:5173"


@pytest.fixture
def boom(tmp_path, monkeypatch):
    """A client over a route that raises.

    `raise_server_exceptions=False` is required, not a shortcut: Starlette's
    ServerErrorMiddleware sends the handler's response and then re-raises so the
    process still logs the fault. The default TestClient turns that re-raise
    into a test error and never lets the response be examined — which is exactly
    why a suite of 1142 tests never noticed what a browser sees here.
    """
    from fastapi.testclient import TestClient

    monkeypatch.setenv("SAW_DB_PATH", str(tmp_path / "test_app.db"))
    monkeypatch.setenv("SAW_DATA_DIR", str(tmp_path))

    from app.main import app

    r = APIRouter()

    @r.get("/__boom")
    def _boom():
        raise RuntimeError("bucket-name-and-key-that-must-not-be-echoed")

    app.include_router(r)
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            yield c
    finally:
        app.router.routes = [x for x in app.router.routes if getattr(x, "path", None) != "/__boom"]


def test_a_fault_answers_500_rather_than_dropping_the_connection(boom):
    res = boom.get("/__boom", headers={"Origin": ORIGIN})
    assert res.status_code == 500


def test_the_browser_can_read_the_500(boom):
    """Without this header the fetch rejects and the real status is unreachable
    from the client — which is the whole bug."""
    res = boom.get("/__boom", headers={"Origin": ORIGIN})
    assert res.headers.get("access-control-allow-origin") == ORIGIN


def test_the_body_names_the_fault_type_and_not_its_message(boom):
    res = boom.get("/__boom", headers={"Origin": ORIGIN})
    detail = res.json()["detail"]
    assert "RuntimeError" in detail
    assert "bucket-name-and-key-that-must-not-be-echoed" not in detail


def test_an_unlisted_origin_gets_no_cors_grant(boom):
    """The allowlist still decides; the handler echoes, it does not widen."""
    res = boom.get("/__boom", headers={"Origin": "http://evil.example"})
    assert res.status_code == 500
    assert "access-control-allow-origin" not in {k.lower() for k in res.headers}


def test_a_normal_404_is_untouched(client):
    assert client.get("/sessions/does-not-exist").status_code == 404
