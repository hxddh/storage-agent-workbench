#!/usr/bin/env python3
"""Build the PyInstaller sidecar and place it where Tauri's externalBin expects it.

Steps:
1. Detect the Rust target triple (via `rustc -Vv`, falling back to a platform map).
2. Run the existing PyInstaller build (sidecar/packaging/build_sidecar.py).
3. Locate the one-file sidecar binary.
4. Copy it to: src-tauri/binaries/storage-agent-sidecar-<target-triple>(.exe)

Notes:
- This is BUILD TOOLING, not application code. The `subprocess` calls below run
  FIXED, internal build commands only (rustc version probe, the sidecar build).
  Nothing here is user-controlled and none of it is exposed as a user/Agent tool.
- Does not read the keyring; needs no AWS/BOS/OpenAI credentials; bundles no
  secrets. The destination dir (src-tauri/binaries/) is gitignored.

Usage:
    python scripts/build-sidecar-for-tauri.py
"""

from __future__ import annotations

import platform
import shutil
import subprocess  # fixed internal build commands only — see module docstring
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SIDECAR = REPO / "sidecar"
BIN_NAME = "storage-agent-sidecar"


def detect_target_triple() -> str:
    """Best-effort Rust target triple for naming the externalBin."""
    try:
        out = subprocess.run(  # noqa: S603 - fixed command, no user input
            ["rustc", "-Vv"], capture_output=True, text=True, check=True
        ).stdout
        for line in out.splitlines():
            if line.startswith("host:"):
                return line.split(":", 1)[1].strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass

    # Fallback platform map (covers the common desktop targets).
    machine = platform.machine().lower()
    system = platform.system().lower()
    arch = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64", "amd64": "x86_64"}.get(machine, machine)
    if system == "darwin":
        return f"{arch}-apple-darwin"
    if system == "linux":
        return f"{arch}-unknown-linux-gnu"
    if system == "windows":
        return f"{arch}-pc-windows-msvc"
    raise SystemExit(f"Unsupported platform: {system}/{machine}")


def find_built_binary() -> Path:
    suffix = ".exe" if platform.system().lower() == "windows" else ""
    onefile = SIDECAR / "dist" / (BIN_NAME + suffix)
    onedir = SIDECAR / "dist" / BIN_NAME / (BIN_NAME + suffix)
    if onefile.exists():
        return onefile
    if onedir.exists():
        return onedir
    raise SystemExit(
        f"Sidecar binary not found at {onefile} or {onedir}. PyInstaller build may have failed."
    )


def main() -> int:
    triple = detect_target_triple()
    print(f"Target triple: {triple}", flush=True)

    print("Building sidecar with PyInstaller …", flush=True)
    rc = subprocess.run(  # noqa: S603 - fixed internal build command
        [sys.executable, "packaging/build_sidecar.py"], cwd=str(SIDECAR)
    ).returncode
    if rc != 0:
        raise SystemExit(f"Sidecar build failed (exit {rc}).")

    built = find_built_binary()
    suffix = ".exe" if platform.system().lower() == "windows" else ""
    dest_dir = REPO / "src-tauri" / "binaries"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{BIN_NAME}-{triple}{suffix}"
    shutil.copy2(built, dest)
    dest.chmod(0o755)
    print(f"Copied sidecar -> {dest.relative_to(REPO)}", flush=True)
    print("Done. (binaries/ is gitignored — do not commit the binary.)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
