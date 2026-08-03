"""Packaged entrypoint for the Storage Agent sidecar.

This is the entrypoint PyInstaller bundles and that the Tauri desktop app
launches as a sidecar process. It is a thin, production-oriented wrapper around
the FastAPI app:

    storage-agent-sidecar --host 127.0.0.1 --port 8765 --data-dir <path>

Behavior:
- Binds localhost by default.
- Host/port/data-dir come from CLI args or environment variables.
- Production mode: uvicorn ``reload`` is always OFF.
- No generic shell and no user-command process execution.
- Startup logging is sanitized and never prints secrets or env values.

Environment variables (CLI args take precedence):
- ``STORAGE_AGENT_HOST`` (default ``127.0.0.1``)
- ``STORAGE_AGENT_PORT`` (default ``8765``)
- ``STORAGE_AGENT_DATA_DIR`` (default: the app's data dir)
"""

from __future__ import annotations

import argparse
import os
import sys

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="storage-agent-sidecar",
        description="Local-only sidecar for Storage Agent Workbench.",
    )
    parser.add_argument("--host", default=os.environ.get("STORAGE_AGENT_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("STORAGE_AGENT_PORT", DEFAULT_PORT)))
    parser.add_argument("--data-dir", default=os.environ.get("STORAGE_AGENT_DATA_DIR"))
    return parser


def configure(args: argparse.Namespace) -> None:
    """Apply CLI/env configuration to the process environment.

    Setting the data dir via env keeps a single resolution path
    (``app.config.data_dir``) for dev and packaged modes alike.
    """
    if args.data_dir:
        os.environ["STORAGE_AGENT_DATA_DIR"] = str(args.data_dir)

    # The desktop launcher spawns this process with the user's FULL environment
    # inherited. ``OPENAI_LOG=debug`` makes the openai/httpx SDK loggers dump
    # every request/response — the whole conversation prompt and tool output — to
    # this child's stderr, which the desktop app captures. The current SDK
    # redacts credential headers, but conversation content shouldn't hit the log
    # either, and that protection is version-dependent. Drop it and pin the noisy
    # library loggers so a stray env var can't turn on verbose wire logging.
    os.environ.pop("OPENAI_LOG", None)
    import logging

    for _name in ("httpx", "httpcore", "openai", "botocore", "boto3", "urllib3"):
        logging.getLogger(_name).setLevel(logging.WARNING)


def _start_parent_watchdog() -> None:
    """Exit if the launching parent (the desktop app) goes away.

    Prevents orphaned sidecar processes: with a PyInstaller one-file bundle the
    bootloader re-execs a child, and a parent's kill of the bootloader does not
    always take down that child. Tauri passes its own PID as
    STORAGE_AGENT_PARENT_PID; we poll it and exit cleanly when it disappears.
    No-ops in dev/standalone (no parent PID and a normal parent).
    """
    import os
    import sys
    import threading
    import time

    parent_pid = os.environ.get("STORAGE_AGENT_PARENT_PID")

    def _watch_windows(pid: int) -> None:
        """Wait on a real process HANDLE — never ``os.kill``.

        On Windows ``os.kill(pid, 0)`` is NOT a liveness probe: CPython maps any
        signal other than CTRL_C/CTRL_BREAK_EVENT to
        ``OpenProcess(PROCESS_ALL_ACCESS) + TerminateProcess(handle, sig)``. This
        watchdog therefore *killed the desktop app it was guarding* two seconds
        after launch, then (with the parent gone, and OpenProcess failing with a
        plain OSError the handler below didn't catch) died and left itself
        running as the orphan it exists to prevent.

        A SYNCHRONIZE handle opened once is also immune to PID reuse, and
        WaitForSingleObject blocks until the parent really exits — no polling.
        """
        import ctypes

        SYNCHRONIZE = 0x0010_0000
        INFINITE = 0xFFFF_FFFF
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            os._exit(0)  # parent already gone -> never orphan
        kernel32.WaitForSingleObject(handle, INFINITE)
        os._exit(0)

    def _watch_posix(pid: int) -> None:
        while True:
            time.sleep(2)
            try:
                os.kill(pid, 0)  # signal 0 IS a liveness probe on POSIX
            except ProcessLookupError:
                os._exit(0)  # parent gone -> never orphan
            except PermissionError:
                pass  # exists but not ours; treat as alive

    def _watch_orphan() -> None:
        while True:
            time.sleep(2)
            if os.getppid() == 1:
                os._exit(0)  # reparented to launchd/init -> orphaned

    if parent_pid:
        try:
            pid = int(parent_pid)
        except ValueError:
            return  # malformed env: no watchdog rather than a wrong one
        target = _watch_windows if sys.platform == "win32" else _watch_posix
        threading.Thread(target=target, args=(pid,), daemon=True).start()
    elif sys.platform != "win32":
        # No parent PID (dev/standalone): fall back to the reparenting check,
        # which is a POSIX concept — Windows has no init-reparenting.
        threading.Thread(target=_watch_orphan, daemon=True).start()


def _startup_banner(host: str, port: int) -> str:
    # Sanitized: only the bind address and the data-dir *name* (not full path,
    # which could contain a username), never any secret or env dump.
    # Absolute import so this works both as a module and as a frozen script.
    from app import config

    data_name = config.data_dir().name
    return f"storage-agent-sidecar listening on http://{host}:{port} (data_dir=…/{data_name})"


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv if argv is not None else sys.argv[1:])
    configure(args)

    # Import uvicorn/app lazily so --help and arg parsing stay fast and testable.
    # Importing the app object (not a string) lets PyInstaller capture the graph.
    import uvicorn

    from app.main import app as fastapi_app

    _start_parent_watchdog()
    print(_startup_banner(args.host, args.port), flush=True)
    # Production: never enable reload; bind localhost only. Access logging is
    # OFF: the launcher authenticates the header-less SSE EventSource with a
    # `?token=<shared secret>` query param, and uvicorn's access log would print
    # the full request line — writing the secret to the app log on every SSE
    # connect. Startup/error logs remain on.
    uvicorn.run(fastapi_app, host=args.host, port=args.port, reload=False,
                log_level="info", access_log=False)
    return 0


if __name__ == "__main__":  # pragma: no cover - process entrypoint
    raise SystemExit(main())
