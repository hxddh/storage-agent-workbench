"""Everything ``app/`` imports at runtime must be in the shipped closure.

The defect this exists for, found by review on the v0.85.0 dependency upgrade:
``model_providers.py`` imported ``httpx``, which was never declared — it just
happened to be installed, because the old ``openai`` line depended on it. The
OpenAI 3.x major moved to the httpx 2 line, which ships under a *different*
distribution name (``httpx2``), so ``httpx`` fell out of the runtime closure and
survived only in the dev extra. Every test still passed — the test environment
installs the dev extra — while a plain ``pip install -e .`` and the packaged
desktop bundle would raise ``ModuleNotFoundError`` and answer the provider-test
route with a 500.

So the gate is not "is httpx declared"; it is the class: a module the product
imports at runtime, satisfied only by something the product does not ship. The
lockfile is the shipped closure (runtime dependencies only, dev and packaging
extras deliberately excluded — see ``scripts/lock-sidecar-deps.py``), which is
what makes it the right thing to check against.
"""
from __future__ import annotations

import ast
import importlib.metadata as md
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP = REPO / "app"
LOCK = REPO / "requirements.lock"

# First-party and test-only roots; not distributions.
LOCAL = {"app", "tests"}


def _imported_top_level_modules() -> set[str]:
    """Every top-level module name imported anywhere under ``app/``.

    Deliberately includes function-local imports: the httpx one was inside a
    route handler, which is exactly why it was invisible until the route ran.
    """
    found: set[str] = set()
    for path in sorted(APP.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                found.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                found.add(node.module.split(".")[0])
    return found


def _locked_distributions() -> set[str]:
    return {line.split("==")[0].strip().lower().replace("_", "-")
            for line in LOCK.read_text().splitlines()
            if "==" in line and not line.lstrip().startswith("#")}


def test_every_runtime_import_is_in_the_shipped_closure():
    locked = _locked_distributions()
    assert locked, "lockfile parsed empty — the check would pass vacuously"
    provided = md.packages_distributions()

    unsatisfied: list[str] = []
    for module in sorted(_imported_top_level_modules()):
        if module in sys.stdlib_module_names or module in LOCAL:
            continue
        dists = provided.get(module)
        if not dists:
            # Not importable in this environment at all — a different failure,
            # and one the import check in CI already catches.
            unsatisfied.append(f"{module} (no installed distribution provides it)")
            continue
        if not any(d.lower().replace("_", "-") in locked for d in dists):
            unsatisfied.append(f"{module} (provided by {dists}, none in the lock)")

    assert not unsatisfied, (
        "app/ imports these at runtime, but nothing in requirements.lock ships "
        "them — they resolve here only because the dev extra is installed:\n  "
        + "\n  ".join(unsatisfied))
