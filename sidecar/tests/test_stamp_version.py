"""Release stamp must emit canonical semver (Tauri rejects leading zeros)."""
from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "stamp-version.py"


def _load_stamp_version():
    spec = importlib.util.spec_from_file_location("stamp_version", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_canonical_semver_strips_leading_zeros():
    stamp = _load_stamp_version()
    assert stamp.canonical_semver("v1.00.0") == "1.0.0"
    assert stamp.canonical_semver("1.00.0") == "1.0.0"
    assert stamp.canonical_semver("v0.99.0") == "0.99.0"
    assert stamp.canonical_semver("v1.0.0") == "1.0.0"
    assert stamp.canonical_semver("v1.00.0-rc.1") == "1.0.0"


def test_canonical_semver_rejects_non_versions():
    stamp = _load_stamp_version()
    assert stamp.canonical_semver("") is None
    assert stamp.canonical_semver("main") is None
    assert stamp.canonical_semver("v1.0") is None
