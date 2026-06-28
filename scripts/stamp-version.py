#!/usr/bin/env python3
"""Stamp the bundle version into tauri.conf.json + Cargo.toml from a release tag.

The macOS/Windows bundle version (shown in About) comes from tauri.conf.json, not
the release tag. CI calls this before building so every platform reports the real
version. Derives a numeric X.Y.Z from the tag (strips a leading 'v' and any
-pre/-rc suffix); if the tag has no X.Y.Z, leaves the config default untouched.

Usage: python scripts/stamp-version.py v0.19.4
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

raw = sys.argv[1] if len(sys.argv) > 1 else ""
ver = raw.lstrip("v").split("-")[0]
if not re.match(r"^\d+\.\d+\.\d+$", ver):
    print(f"tag '{raw}' has no X.Y.Z version; keeping config default")
    sys.exit(0)

root = pathlib.Path(__file__).resolve().parent.parent
conf = root / "src-tauri" / "tauri.conf.json"
data = json.loads(conf.read_text())
data["version"] = ver
conf.write_text(json.dumps(data, indent=2) + "\n")

cargo = root / "src-tauri" / "Cargo.toml"
txt = cargo.read_text()
txt = re.sub(r'(?m)^version = "[^"]*"', f'version = "{ver}"', txt, count=1)
cargo.write_text(txt)

print(f"stamped bundle version {ver} (from tag {raw})")
