#!/usr/bin/env python3
"""Regenerate sidecar/requirements.lock from the CURRENTLY INSTALLED closure.

Run this in an environment where `cd sidecar && pytest -q` is green, then commit
the result: the lockfile's job is to record what was actually verified, not what
a resolver might pick tomorrow.

    pip install -e "./sidecar[dev]" --upgrade
    cd sidecar && pytest -q
    python scripts/lock-sidecar-deps.py
"""
from __future__ import annotations

import importlib.metadata as md
from collections import deque
from pathlib import Path

# The sidecar's DECLARED dependencies (pyproject `[project].dependencies`).
# Dev/packaging extras are deliberately excluded: they are not shipped, and
# pinning them would make routine tooling upgrades a lockfile conflict.
ROOTS = ["fastapi", "uvicorn", "keyring", "cryptography", "boto3", "botocore",
         "duckdb", "pyarrow", "pandas", "python-multipart", "openai",
         "openai-agents", "pyyaml"]

HEADER = """\
# Pinned runtime closure for the sidecar. GENERATED — see scripts/lock-sidecar-deps.py.
#
# WHY THIS EXISTS. `pyproject.toml` declares deliberately loose ranges so new
# agent-SDK features flow in. With no lockfile those ranges resolved at INSTALL
# time, so three environments disagreed: v0.55.0 was developed against
# openai-agents 0.17.8 while CI validated it against 0.19.4, and a packaged build
# got whatever was newest that day. Both passed, which was luck — v0.55.0's whole
# token saving rests on `is_enabled` being re-evaluated every step, and
# `>=0.17,<1` would have let a 0.20 that changed it in silently, first visible as
# a broken release.
#
# WHAT IT IS. The exact versions the suite is green against. The ranges in
# pyproject.toml stay as they are: they express what the code SUPPORTS, while
# this records what was actually VERIFIED. CI and packaging install with
# `-c requirements.lock`, so the pins constrain the resolve without turning the
# editable install into a pinned-only one.
#
# Upgrading is a deliberate act: upgrade, run the suite, regenerate, commit.
"""


def closure() -> dict[str, str]:
    seen: set[str] = set()
    out: dict[str, str] = {}
    queue: deque[str] = deque(ROOTS)
    while queue:
        name = queue.popleft().lower().replace("_", "-")
        if name in seen:
            continue
        seen.add(name)
        try:
            dist = md.distribution(name)
        except Exception:  # noqa: BLE001 — an optional/absent dep is not a failure
            continue
        out[name] = dist.version
        for req in dist.requires or []:
            # Skip extras: they are not installed unless asked for, so pinning
            # them would lock versions this deployment does not even have.
            if ";" in req and "extra" in req.split(";", 1)[1]:
                continue
            dep = req.split(";")[0].strip()
            for sep in ("==", ">=", "<=", "~=", "!=", ">", "<", "[", "(", " "):
                if sep in dep:
                    dep = dep.split(sep)[0]
            if dep:
                queue.append(dep.strip())
    return out


def main() -> None:
    pins = closure()
    target = Path(__file__).resolve().parent.parent / "sidecar" / "requirements.lock"
    target.write_text(HEADER + "\n" + "\n".join(f"{k}=={pins[k]}" for k in sorted(pins)) + "\n")
    print(f"wrote {target} ({len(pins)} pinned)")


if __name__ == "__main__":
    main()
