"""Build the packaged sidecar with PyInstaller (Phase 08).

Run from the sidecar/ directory:

    python packaging/build_sidecar.py

Output: sidecar/dist/storage-agent-sidecar/ (one-dir bundle with the
`storage-agent-sidecar` executable inside).

This is BUILD TOOLING, not application code: it invokes PyInstaller's Python
API in-process (no shell). If PyInstaller is not installed or the current
Python/platform is unsupported, it prints a clear message and exits non-zero so
callers can treat it as a skip rather than a false pass.
"""

from __future__ import annotations

import sys
from pathlib import Path

SIDECAR_DIR = Path(__file__).resolve().parents[1]
SPEC = SIDECAR_DIR / "packaging" / "storage-agent-sidecar.spec"
DIST = SIDECAR_DIR / "dist"
WORK = SIDECAR_DIR / "build" / "pyinstaller"


def main() -> int:
    try:
        import PyInstaller.__main__ as pyi
    except ImportError:
        print("PyInstaller is not installed. Install with: pip install -e \".[packaging]\"", file=sys.stderr)
        return 2

    print(f"Building sidecar bundle from {SPEC.relative_to(SIDECAR_DIR)} …", flush=True)
    pyi.run([
        str(SPEC),
        "--noconfirm",
        "--distpath", str(DIST),
        "--workpath", str(WORK),
    ])
    target = DIST / "storage-agent-sidecar"
    print(f"Built: {target}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
