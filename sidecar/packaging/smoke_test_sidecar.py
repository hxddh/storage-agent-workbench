"""Smoke test for the packaged sidecar (Phase 08).

Starts the PyInstaller-built sidecar, calls GET /health, then GET
/health/selfcheck — a DEEP check that imports/instantiates the packaging-critical
runtime a bare /health never touches (OpenAI Agents SDK, a botocore S3 client,
the DuckDB/PyArrow engines, and the `cryptography` AES-GCM binding the secret
vault decrypts with). A bundle can pass /health while silently missing one of
those, so asserting the self-check turns a "breaks in the user's hands" bug into
a build failure. All offline: no AWS/OPENAI_API_KEY/keyring secrets. Exit codes:
    0  -> health ok AND all self-check components ok (PASS)
    0  -> bundle not built (SKIP, printed clearly — NOT a false pass)
    1  -> bundle present but health or a self-check component failed (FAIL)

NOTE on subprocess: launching the packaged sidecar is an INTERNAL packaged-app
lifecycle action (the same thing Tauri does in production). This script is build
tooling, not application code, and it never executes user-controlled commands.

Does not require AWS/BOS/MinIO, OPENAI_API_KEY, or real keyring secrets.
"""

from __future__ import annotations

import os
import subprocess  # internal packaged-sidecar lifecycle only (see module note)
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

SIDECAR_DIR = Path(__file__).resolve().parents[1]
PORT = 8771
HOST = "127.0.0.1"


def _binary() -> Path:
    name = "storage-agent-sidecar"
    suffix = ".exe" if os.name == "nt" else ""
    # One-dir (current mode): dist/storage-agent-sidecar/ is a folder whose inner
    # executable is what we run. Check it first and use is_file() — the one-file
    # path (dist/storage-agent-sidecar) is now that *folder*, so .exists() alone
    # would wrongly match the directory.
    onedir = SIDECAR_DIR / "dist" / name / (name + suffix)
    onefile = SIDECAR_DIR / "dist" / (name + suffix)
    if onedir.is_file():
        return onedir
    return onefile


def _get_json(path: str, timeout: float = 10.0) -> dict | None:
    import json

    url = f"http://{HOST}:{PORT}{path}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 - localhost only
            if resp.status == 200:
                return json.loads(resp.read().decode())
    except (urllib.error.URLError, ConnectionError, OSError):
        return None
    return None


def _wait_health(timeout: float = 90.0) -> dict | None:
    # The bundle is heavy (duckdb/pyarrow/pandas); first cold start can take
    # 20s+ while PyInstaller extracts native libs.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        got = _get_json("/health", timeout=2)
        if got is not None:
            return got
        time.sleep(0.5)
    return None


def main() -> int:
    binary = _binary()
    if not binary.exists():
        print(f"SKIP: packaged sidecar not found at {binary}. Run build_sidecar.py first.")
        return 0

    env = dict(os.environ)
    env["STORAGE_AGENT_DATA_DIR"] = tempfile.mkdtemp(prefix="saw-smoke-")
    env.pop("OPENAI_API_KEY", None)  # ensure no model key dependency

    print(f"Starting packaged sidecar: {binary} --port {PORT}")
    proc = subprocess.Popen(  # noqa: S603 - fixed packaged binary, no user input
        [str(binary), "--host", HOST, "--port", str(PORT)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        health = _wait_health()
        if not (health and health.get("status") == "ok"):
            print("FAIL: packaged sidecar did not report healthy.")
            return 1
        print(f"/health ok: {health}")

        # Deep check: a bundle can pass /health while missing a lazily imported
        # native dep. The self-check exercises the real runtime offline.
        deep = _get_json("/health/selfcheck", timeout=60)
        if deep is None:
            print("FAIL: /health/selfcheck did not respond.")
            return 1
        checks = deep.get("checks", {})
        if deep.get("status") == "ok":
            print(f"PASS: /health/selfcheck all ok: {checks}")
            return 0
        broken = {k: v for k, v in checks.items() if v != "ok"}
        print(f"FAIL: packaged bundle self-check degraded: {broken or deep}")
        return 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
