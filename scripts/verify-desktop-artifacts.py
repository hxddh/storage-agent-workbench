#!/usr/bin/env python3
"""Cross-platform desktop artifact verifier (Phase 11).

Checks that the sidecar externalBin for the current target triple is present and
lists any desktop bundle artifacts produced under src-tauri/target/release/
bundle/ (macOS .app/.dmg, Linux .deb/.rpm/.AppImage, Windows .exe/.msi).

Read-only inspection. No GUI launch, no signing, no cloud/keyring access.
Exit codes:
    0  externalBin present (artifacts listed; absence of bundles is reported, not failed)
    1  externalBin missing for the current triple
"""

from __future__ import annotations

import platform
import subprocess  # fixed internal command (rustc probe) only
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BIN_NAME = "storage-agent-sidecar"
BUNDLE = REPO / "src-tauri" / "target" / "release" / "bundle"


def target_triple() -> str:
    try:
        out = subprocess.run(["rustc", "-Vv"], capture_output=True, text=True, check=True).stdout
        for line in out.splitlines():
            if line.startswith("host:"):
                return line.split(":", 1)[1].strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass
    machine = platform.machine().lower()
    arch = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64", "amd64": "x86_64"}.get(machine, machine)
    system = platform.system().lower()
    return {"darwin": f"{arch}-apple-darwin", "linux": f"{arch}-unknown-linux-gnu",
            "windows": f"{arch}-pc-windows-msvc"}.get(system, f"{arch}-unknown")


def main() -> int:
    triple = target_triple()
    suffix = ".exe" if platform.system().lower() == "windows" else ""
    ext_bin = REPO / "src-tauri" / "binaries" / f"{BIN_NAME}-{triple}{suffix}"
    print(f"Target triple: {triple}")

    if not ext_bin.exists():
        print(f"FAIL: externalBin missing: {ext_bin.relative_to(REPO)}")
        print("Run: python3 scripts/build-sidecar-for-tauri.py")
        return 1
    print(f"OK externalBin: {ext_bin.relative_to(REPO)} ({ext_bin.stat().st_size} bytes)")

    patterns = ["macos/*.app", "dmg/*.dmg", "deb/*.deb", "rpm/*.rpm",
                "appimage/*.AppImage", "nsis/*.exe", "msi/*.msi"]
    found = []
    if BUNDLE.exists():
        for pat in patterns:
            found += list(BUNDLE.glob(pat))
    if found:
        print("Bundle artifacts:")
        for f in found:
            print(f"  - {f.relative_to(REPO)}")
    else:
        print("No bundle artifacts found yet (run a bundle build for this platform).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
