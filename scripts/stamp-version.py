#!/usr/bin/env python3
"""Stamp a single X.Y.Z version across every version-bearing file from a tag.

CI calls this before building so every platform reports the real release
version. Stamps, in one pass and idempotently:

- ``src-tauri/tauri.conf.json``  — the macOS/Windows bundle version (About box)
- ``src-tauri/Cargo.toml``       — the Rust crate version
- ``sidecar/pyproject.toml``     — the Python sidecar package version
- ``frontend/package.json``      — the frontend package version

The FastAPI ``version=`` in ``sidecar/app/main.py`` is NOT hardcoded — it reads
``importlib.metadata.version("storage-agent-sidecar")``, so stamping
``pyproject.toml`` (which the installed package metadata comes from) keeps the
service version in lockstep automatically. Nothing to stamp there.

Derives a numeric X.Y.Z from the tag (strips a leading 'v' and any -pre/-rc
suffix); if the tag has no X.Y.Z, leaves every file untouched. Fails loudly if
any expected version pattern is missing, and asserts all files agree afterward.

Usage: python scripts/stamp-version.py v0.21.1
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

raw = sys.argv[1] if len(sys.argv) > 1 else ""
ver = raw.lstrip("v").split("-")[0]
if not re.match(r"^\d+\.\d+\.\d+$", ver):
    print(f"tag '{raw}' has no X.Y.Z version; keeping every file untouched")
    sys.exit(0)

root = pathlib.Path(__file__).resolve().parent.parent


def _die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def stamp_json_version(path: pathlib.Path) -> str:
    if not path.exists():
        _die(f"{path} not found")
    data = json.loads(path.read_text())
    if "version" not in data:
        _die(f"{path} has no top-level 'version' key")
    data["version"] = ver
    path.write_text(json.dumps(data, indent=2) + "\n")
    return ver


def stamp_toml_version(path: pathlib.Path) -> str:
    """Replace the first ``version = "..."`` line (the package/crate version).

    Package version lines are pinned literals; dependency constraints use
    operators (``>=``, ``<``) and never match ``^version = "..."``.
    """
    if not path.exists():
        _die(f"{path} not found")
    txt = path.read_text()
    new_txt, n = re.subn(r'(?m)^version = "[^"]*"', f'version = "{ver}"', txt, count=1)
    if n != 1:
        _die(f'{path}: expected exactly one `version = "..."` line, found {n}')
    path.write_text(new_txt)
    # Read back the value we just wrote, to feed the consistency assertion.
    m = re.search(r'(?m)^version = "([^"]*)"', new_txt)
    return m.group(1) if m else ""


targets = {
    "src-tauri/tauri.conf.json": stamp_json_version(root / "src-tauri" / "tauri.conf.json"),
    "src-tauri/Cargo.toml": stamp_toml_version(root / "src-tauri" / "Cargo.toml"),
    "sidecar/pyproject.toml": stamp_toml_version(root / "sidecar" / "pyproject.toml"),
    "frontend/package.json": stamp_json_version(root / "frontend" / "package.json"),
}

# Consistency assertion: every stamped file must now agree on the version.
disagree = {name: got for name, got in targets.items() if got != ver}
if disagree:
    _die(f"stamped versions disagree with {ver}: {disagree}")

print(f"stamped version {ver} (from tag {raw}) across: {', '.join(targets)}")
