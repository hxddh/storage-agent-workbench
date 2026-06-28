#!/usr/bin/env python3
"""Build the PyInstaller sidecar (one-dir) and stage it for Tauri to bundle.

Steps:
1. Run the existing PyInstaller build (sidecar/packaging/build_sidecar.py),
   which produces a ONE-DIR bundle at sidecar/dist/storage-agent-sidecar/.
2. Copy that whole folder to: src-tauri/sidecar-dist/storage-agent-sidecar/

Tauri bundles src-tauri/sidecar-dist/ as a resource (see tauri.conf.json
`bundle.resources`), and the desktop app launches the inner executable directly
(see src-tauri/src/lib.rs). This replaces the old one-file + `externalBin`
approach: one-file self-extracted on every launch and macOS Gatekeeper re-scanned
the extracted libs each time, making cold start ~60s. One-dir keeps the libs at a
stable path scanned once, so cold start drops to ~the Python import time.

Notes:
- This is BUILD TOOLING, not application code. The `subprocess` call below runs a
  FIXED, internal build command only (the sidecar build). Nothing is
  user-controlled and none of it is exposed as a user/Agent tool.
- Does not read the keyring; needs no AWS/BOS/OpenAI credentials; bundles no
  secrets. The destination dir (src-tauri/sidecar-dist/) is gitignored.

Usage:
    python scripts/build-sidecar-for-tauri.py
"""

from __future__ import annotations

import platform
import shutil
import subprocess  # fixed internal build command only — see module docstring
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SIDECAR = REPO / "sidecar"
BIN_NAME = "storage-agent-sidecar"


def find_built_bundle() -> Path:
    """Locate the one-dir bundle folder and verify the inner executable exists."""
    suffix = ".exe" if platform.system().lower() == "windows" else ""
    bundle = SIDECAR / "dist" / BIN_NAME
    inner = bundle / (BIN_NAME + suffix)
    if bundle.is_dir() and inner.exists():
        return bundle
    raise SystemExit(
        f"Sidecar one-dir bundle not found at {bundle} (expected inner {inner}). "
        "PyInstaller build may have failed or is still one-file."
    )


def main() -> int:
    print("Building sidecar with PyInstaller (one-dir) …", flush=True)
    rc = subprocess.run(  # noqa: S603 - fixed internal build command
        [sys.executable, "packaging/build_sidecar.py"], cwd=str(SIDECAR)
    ).returncode
    if rc != 0:
        raise SystemExit(f"Sidecar build failed (exit {rc}).")

    bundle = find_built_bundle()
    dest_dir = REPO / "src-tauri" / "sidecar-dist"
    dest = dest_dir / BIN_NAME
    if dest.exists():
        shutil.rmtree(dest)
    dest_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(bundle, dest)

    # Ensure the inner executable stays executable.
    suffix = ".exe" if platform.system().lower() == "windows" else ""
    (dest / (BIN_NAME + suffix)).chmod(0o755)
    print(f"Staged sidecar one-dir -> {dest.relative_to(REPO)}", flush=True)
    print("Done. (sidecar-dist/ is gitignored — do not commit the bundle.)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
