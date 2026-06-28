"""Smoke test for the packaged sidecar (Phase 08).

Starts the PyInstaller-built sidecar, calls GET /health, asserts status ok, then
terminates the process. Exit codes:
    0  -> health ok (PASS)
    0  -> bundle not built (SKIP, printed clearly — NOT a false pass)
    1  -> bundle present but health failed (FAIL)

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


def _wait_health(timeout: float = 90.0) -> dict | None:
    # The bundle is heavy (duckdb/pyarrow/pandas); first cold start can take
    # 20s+ while PyInstaller extracts native libs.
    deadline = time.monotonic() + timeout
    url = f"http://{HOST}:{PORT}/health"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:  # noqa: S310 - localhost only
                if resp.status == 200:
                    import json
                    return json.loads(resp.read().decode())
        except (urllib.error.URLError, ConnectionError, OSError):
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
        if health and health.get("status") == "ok":
            print(f"PASS: /health returned {health}")
            return 0
        print("FAIL: packaged sidecar did not report healthy.")
        return 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
