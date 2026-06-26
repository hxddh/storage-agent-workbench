#!/usr/bin/env python3
"""Cross-platform runtime verification for the desktop app (Phase 12).

Verifies the *runtime* lifecycle of a built desktop app + its bundled sidecar,
without any GUI screen inspection and without cloud/keyring secrets:

Required checks (exit 1 on failure):
  1. app executable found
  2. bundled sidecar (externalBin) found
  3. direct sidecar smoke: run the sidecar binary -> GET /health == ok
  4. app data dir is NOT written under the install/app dir

Best-effort check (reported; hard-fails only with --require-launch):
  5. launch lifecycle: start the app, confirm it spawns the bundled sidecar on a
     free port, GET /health on it, quit the app, confirm the sidecar is cleaned
     up (no orphan) via the parent-PID watchdog.

NOTE: launching the app and inspecting processes uses FIXED internal commands
only (open/Popen/ps/taskkill). Nothing here is user-controlled or exposed as a
user/Agent tool. No AWS/BOS/OpenAI/Vercel credentials; no real keyring secret.

Usage:
  python3 verify-runtime-common.py --main-exe <path> --sidecar <path> \
      --install-root <dir> [--app-bundle <path.app>] [--require-launch]
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import socket
import subprocess  # fixed internal lifecycle commands only (see module docstring)
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

IS_WIN = platform.system().lower() == "windows"
IS_MAC = platform.system().lower() == "darwin"
SIDE_NAME = "storage-agent-sidecar"
APP_NAME = "storage-agent-workbench"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _health(port: int, timeout: float) -> dict | None:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/health"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:  # noqa: S310 - localhost only
                if r.status == 200:
                    return json.loads(r.read().decode())
        except (urllib.error.URLError, ConnectionError, OSError):
            time.sleep(1)
    return None


def _sidecar_procs() -> list[tuple[int, int]]:
    """Return [(pid, port)] for running bundled-sidecar processes."""
    out = []
    if IS_WIN:
        try:
            ps = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "Get-CimInstance Win32_Process -Filter \"Name='storage-agent-sidecar.exe'\" | "
                 "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
                capture_output=True, text=True, timeout=20).stdout
        except (FileNotFoundError, subprocess.SubprocessError):
            ps = ""
        for line in ps.splitlines():
            m = re.search(r"^(\d+)\t.*--port\s+(\d+)", line)
            if m:
                out.append((int(m.group(1)), int(m.group(2))))
    else:
        try:
            ps = subprocess.run(["ps", "-axww", "-o", "pid=,command="],
                                capture_output=True, text=True, timeout=20).stdout
        except (FileNotFoundError, subprocess.SubprocessError):
            ps = ""
        for line in ps.splitlines():
            if SIDE_NAME in line and "--port" in line:
                m = re.match(r"\s*(\d+)\s+.*--port\s+(\d+)", line)
                if m:
                    out.append((int(m.group(1)), int(m.group(2))))
    return out


def _kill_app(main_exe: Path, app_bundle: str | None) -> None:
    if IS_MAC and app_bundle:
        subprocess.run(["osascript", "-e", 'quit app "Storage Agent Workbench"'],
                       capture_output=True)
        time.sleep(1)
        subprocess.run(["pkill", "-f", str(main_exe)], capture_output=True)
    elif IS_WIN:
        subprocess.run(["taskkill", "/IM", f"{APP_NAME}.exe", "/F"], capture_output=True)
    else:
        subprocess.run(["pkill", "-f", str(main_exe)], capture_output=True)


# --- required checks --------------------------------------------------------


def check_direct_sidecar_smoke(sidecar: Path) -> bool:
    port = _free_port()
    data_dir = tempfile.mkdtemp(prefix="saw-rt-")
    env = dict(os.environ)
    env["STORAGE_AGENT_DATA_DIR"] = data_dir
    env.pop("OPENAI_API_KEY", None)
    proc = subprocess.Popen([str(sidecar), "--host", "127.0.0.1", "--port", str(port)],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        health = _health(port, timeout=90)
        ok = bool(health and health.get("status") == "ok")
        print(f"  direct sidecar /health: {'OK' if ok else 'FAIL'} ({health})")
        return ok
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(data_dir, ignore_errors=True)


def check_no_user_data_in_install(install_root: Path) -> bool:
    bad = []
    if install_root.exists():
        for pat in ("app.db", "*.duckdb", ".env"):
            bad += list(install_root.rglob(pat))
        for d in ("runs", "data"):
            bad += list(install_root.rglob(d))
    if bad:
        print(f"  install dir contains user data: FAIL ({[str(b) for b in bad[:3]]})")
        return False
    print("  no user data under install dir: OK")
    return True


# --- best-effort launch lifecycle ------------------------------------------


def check_launch_lifecycle(main_exe: Path, app_bundle: str | None) -> tuple[str, str]:
    """Returns (result, detail): result in {PASS, FAIL, SKIP}."""
    if not main_exe.exists():
        return "SKIP", f"app exe not found: {main_exe}"

    # Launch the app.
    try:
        if IS_MAC and app_bundle:
            subprocess.run(["open", app_bundle], check=True, capture_output=True)
        else:
            subprocess.Popen([str(main_exe)], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
    except (FileNotFoundError, subprocess.SubprocessError) as exc:
        return "SKIP", f"could not launch app (no display?): {exc}"

    # Wait for the spawned sidecar + port (cold start can be slow).
    port = None
    for _ in range(45):
        procs = _sidecar_procs()
        if procs:
            port = procs[0][1]
            break
        time.sleep(2)
    if not port:
        _kill_app(main_exe, app_bundle)
        return "FAIL", "app did not spawn a bundled sidecar (or display unavailable)"

    health = _health(port, timeout=60)
    if not (health and health.get("status") == "ok"):
        _kill_app(main_exe, app_bundle)
        return "FAIL", f"app's sidecar /health not ok on port {port}"

    # Quit and confirm cleanup (parent-PID watchdog kills the sidecar).
    _kill_app(main_exe, app_bundle)
    cleaned = False
    for _ in range(10):
        time.sleep(2)
        if not _sidecar_procs():
            cleaned = True
            break
    if not cleaned:
        # last-resort cleanup so we don't leave orphans on the runner
        for pid, _p in _sidecar_procs():
            try:
                os.kill(pid, 9)
            except OSError:
                pass
        return "FAIL", "sidecar not cleaned up after app quit (orphan)"
    return "PASS", f"launch -> sidecar on :{port} -> /health ok -> quit -> cleaned up"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--main-exe", required=True)
    ap.add_argument("--sidecar", required=True)
    ap.add_argument("--install-root", required=True)
    ap.add_argument("--app-bundle", default=None)
    ap.add_argument("--require-launch", action="store_true")
    args = ap.parse_args()

    main_exe = Path(args.main_exe)
    sidecar = Path(args.sidecar)
    install_root = Path(args.install_root)

    print(f"== Runtime verification ({platform.system()} {platform.machine()}) ==")
    required_ok = True

    print(f"[1] app executable: {main_exe}")
    if not main_exe.exists():
        print("  FAIL: not found"); required_ok = False
    else:
        print("  OK")

    print(f"[2] bundled sidecar: {sidecar}")
    if not sidecar.exists():
        print("  FAIL: not found"); required_ok = False
    else:
        print("  OK")

    print("[3] direct sidecar smoke")
    if not sidecar.exists() or not check_direct_sidecar_smoke(sidecar):
        required_ok = False

    print("[4] app data dir not under install dir")
    if not check_no_user_data_in_install(install_root):
        required_ok = False

    print("[5] app launch lifecycle (best-effort unless --require-launch)")
    result, detail = check_launch_lifecycle(main_exe, args.app_bundle)
    print(f"  LAUNCH: {result} — {detail}")

    print("== Summary ==")
    print(f"  required checks: {'PASS' if required_ok else 'FAIL'}")
    print(f"  launch lifecycle: {result}")

    if not required_ok:
        return 1
    if args.require_launch and result != "PASS":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
