"""The Storage Agent Sidecar (v5).

A local FastAPI service the desktop shell starts on 127.0.0.1. It owns the one
Agent runtime, the durable items stream every surface projects, the storage
estate, and the provider settings. Storage is read-only; secrets live in the
encrypted vault and never leave this process.

Local-process isolation: binding to ``127.0.0.1`` keeps the socket off the
network, but other local processes can still reach it. When the launcher sets
``STORAGE_AGENT_AUTH_TOKEN`` every request must carry it (``X-Sidecar-Token``,
or ``?token=`` for the header-less ``EventSource``). Unset — dev and tests —
auth stays open.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .agent import tools as _tools  # noqa: F401  (registers every tool)
from .agent.runtime import RUNTIME
from .api import estate, health, mcp, providers, settings, tasks
from .db import init_db
from .security.redaction import redact_text

SERVICE_NAME = health.SERVICE_NAME
logger = logging.getLogger(__name__)

_AUTH_TOKEN = os.environ.get("STORAGE_AGENT_AUTH_TOKEN") or None
_AUTH_EXEMPT_PATHS = {"/health"}


def watch_tick_seconds() -> int:
    """How often the estate watch looks for due sweeps
    (``STORAGE_AGENT_WATCH_TICK_SECONDS``, default 60, floor 5)."""
    try:
        return max(5, int(os.environ.get("STORAGE_AGENT_WATCH_TICK_SECONDS", "60")))
    except ValueError:
        return 60


def _import_v4() -> None:
    from . import importer
    from .db import connect
    conn = connect()
    try:
        importer.run_once(conn)
    except Exception:  # noqa: BLE001 — an import problem never blocks startup
        logger.exception("v4 import failed")
    finally:
        conn.close()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    await asyncio.to_thread(_import_v4)
    RUNTIME.start()
    # Turns a previous process left running are stamped interrupted and
    # continued once each; queued turns are picked up again.
    await asyncio.to_thread(RUNTIME.recover)

    async def _watch() -> None:
        from .estate import watch as estate_watch
        interval = watch_tick_seconds()
        while True:
            await asyncio.sleep(interval)
            try:
                await asyncio.to_thread(estate_watch.tick)
            except Exception:  # noqa: BLE001 — a failed tick retries next time
                logger.exception("watch tick failed")

    ticker = asyncio.create_task(_watch())
    async with contextlib.AsyncExitStack() as stack:
        if mcp.SERVER is not None:
            await stack.enter_async_context(mcp.SERVER.session_manager.run())
        try:
            yield
        finally:
            ticker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await ticker
            RUNTIME.stop_all()


app = FastAPI(title="Storage Agent Sidecar", version=__version__,
              description="Local-first Agent for object storage.", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def _sanitized_validation_handler(request: Request, exc: RequestValidationError):
    """422s must never echo the plaintext request body.

    FastAPI's default handler returns ``exc.errors()`` verbatim, and pydantic v2
    attaches the offending ``input`` to each error — for a "missing required
    field" error that ``input`` is the WHOLE request body. On the provider-create
    endpoints that body carries the plaintext access key / secret key / session
    token / model API key, so the default 422 would leak them into the HTTP
    response and, from there, the UI error banner (violating the redaction rule).
    Rebuild the error list with ``input`` dropped and every remaining string
    redaction-passed, keeping the useful ``type``/``loc``/``msg`` for the client.
    """
    cleaned = []
    for err in exc.errors():
        item = {k: v for k, v in err.items() if k != "input"}
        if isinstance(item.get("msg"), str):
            item["msg"] = redact_text(item["msg"])
        cleaned.append(item)
    return JSONResponse({"detail": cleaned}, status_code=422)


@app.exception_handler(Exception)
async def _unhandled_error_handler(request: Request, exc: Exception):
    """Answer an unhandled server fault with a readable, CORS-visible 500.

    Starlette's default lets the exception escape as a bare ASGI error, and that
    response is produced OUTSIDE ``CORSMiddleware`` — so the browser sees a
    cross-origin response with no ``Access-Control-Allow-Origin`` and reports it
    as ``TypeError: Failed to fetch``. The frontend then shows a network error
    for what is really a server bug, which is how a 500 on
    ``GET /sessions/{id}`` read for several releases as "the sidecar is
    unreachable" instead of "this endpoint is broken".

    The body carries only the exception TYPE, never its message: a message can
    quote the request that produced it, and this is the one response shape that
    is reached by definition without having been reasoned about. The full
    traceback still goes to the local server log.
    """
    logger.exception("unhandled error on %s %s", request.method, request.url.path)
    origin = request.headers.get("origin")
    headers = {"Access-Control-Allow-Origin": origin} if origin in _ALLOWED_ORIGINS else {}
    return JSONResponse(
        {"detail": f"internal error ({type(exc).__name__})"}, status_code=500, headers=headers,
    )


@app.middleware("http")
async def _require_sidecar_token(request: Request, call_next):
    """Reject any local caller that doesn't present the launcher's shared secret.

    No-op when ``STORAGE_AGENT_AUTH_TOKEN`` is unset (dev/test). CORS preflight
    (``OPTIONS``) and the liveness endpoint stay open so the browser handshake
    and health probes work before a token is in hand.
    """
    if _AUTH_TOKEN is not None and request.method != "OPTIONS":
        if request.url.path not in _AUTH_EXEMPT_PATHS:
            presented = request.headers.get("x-sidecar-token") or request.query_params.get("token")
            # Constant-time comparison: a plain `!=` short-circuits on the first
            # differing byte, which lets a local prober time-oracle the token.
            if presented is None or not hmac.compare_digest(presented, _AUTH_TOKEN):
                return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)

# Local dev origins only; not intended to be exposed to the network.
_ALLOWED_ORIGINS = [
    "http://localhost:1420",  # Tauri v2 default dev origin
    "http://127.0.0.1:1420",
    "http://localhost:5173",  # Vite default dev origin
    "http://127.0.0.1:5173",
    "tauri://localhost",      # Tauri production webview origin (macOS/iOS)
    # Tauri v2 serves the packaged app from http(s)://tauri.localhost on Windows
    # (WebView2) and Android. Every frontend call carries X-Sidecar-Token, a
    # non-simple header, so it is preflighted — without these origins the
    # packaged Windows app cannot talk to its own sidecar at all. Widening CORS
    # costs nothing here: the token gate above is the real authorization
    # boundary, and CORS never protected a non-browser caller anyway.
    "http://tauri.localhost",
    "https://tauri.localhost",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(tasks.router)
app.include_router(tasks.events_router)
app.include_router(estate.router)
app.include_router(providers.router)
app.include_router(settings.router)
if mcp.SERVER is not None:
    app.mount("/mcp", mcp.SERVER.streamable_http_app(streamable_http_path="/", stateless_http=True,
                                                     json_response=True))
