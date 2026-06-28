#!/usr/bin/env python3
"""Cross-platform desktop artifact verifier.

Checks that the staged sidecar one-dir bundle (the Tauri resource) is present and
lists any desktop bundle artifacts produced under src-tauri/target/release/
bundle/ (macOS .app/.dmg, Linux .deb/.rpm/.AppImage, Windows .exe/.msi).

Read-only inspection. No GUI launch, no signing, no cloud/keyring access.
Exit codes:
    0  staged sidecar present (artifacts listed; absence of bundles is reported, not failed)
    1  staged sidecar one-dir missing
"""

from __future__ import annotations

import platform
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BIN_NAME = "storage-agent-sidecar"
BUNDLE = REPO / "src-tauri" / "target" / "release" / "bundle"


def main() -> int:
    suffix = ".exe" if platform.system().lower() == "windows" else ""
    # build-sidecar-for-tauri.py stages the one-dir bundle here; tauri.conf.json
    # bundles it via bundle.resources.
    staged = REPO / "src-tauri" / "sidecar-dist" / BIN_NAME
    inner = staged / (BIN_NAME + suffix)

    if not inner.exists():
        print(f"FAIL: staged sidecar one-dir missing: {inner.relative_to(REPO)}")
        print("Run: python3 scripts/build-sidecar-for-tauri.py")
        return 1
    print(f"OK staged sidecar: {staged.relative_to(REPO)}/ (launcher {inner.stat().st_size} bytes)")

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
