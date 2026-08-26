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

**And the other direction**, added in v0.86.0 because the one-way check has a
blind spot the same size. A dependency can be *declared and shipped* while
nothing imports it — which is how ``keyring`` survived: the product moved its
secrets to a self-managed AES-256-GCM vault and stopped using the OS keychain,
but the declaration stayed, and with it ``jeepney`` and ``secretstorage``, whose
entire purpose is to talk to the keychain the security rules explicitly reject.
Dead weight in the bundle is bad; dead weight that implements the mechanism you
deliberately refused is worse.
"""
from __future__ import annotations

import ast
import importlib.metadata as md
import re
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


# --- the other direction: declared, but does anything import it? -------------

# Runtime dependencies a working product needs WITHOUT any `import` of its own.
# An entry here is a claim that the dependency is reached through another
# library's machinery, and it must say by whom — an unexplained name would turn
# this gate back into the rubber stamp it exists to replace.
IMPLICIT_RUNTIME_DEPS = {
    # FastAPI parses multipart bodies (UploadFile / Form) through it. The
    # evidence-upload routes stop working without it, and no app module names it.
    "python-multipart",
}


def _declared_runtime_dependencies() -> list[str]:
    """Names from ``[project].dependencies`` only — not the dev/packaging extras.

    Same parse as test_v056: terminate on a `]` at the start of a line, because
    a bare `]` split lands inside `"uvicorn[standard]>=0.27"`.
    """
    text = (REPO / "pyproject.toml").read_text()
    block = re.split(r"\n\]", text.split("dependencies = [", 1)[1], maxsplit=1)[0]
    return re.findall(r'^\s*"([A-Za-z0-9._-]+)(?:\[[^\]]*\])?[><=!~]', block, re.M)


def test_every_declared_runtime_dependency_is_actually_used():
    imported = _imported_top_level_modules()
    provided = md.packages_distributions()

    # distribution -> the module names it installs
    dist_to_modules: dict[str, set[str]] = {}
    for module, dists in provided.items():
        for dist in dists:
            dist_to_modules.setdefault(dist.lower().replace("_", "-"), set()).add(module)

    deps = _declared_runtime_dependencies()
    assert len(deps) >= 10, f"parsed only {deps} — the dependency block shape changed"

    unused: list[str] = []
    for dep in deps:
        key = dep.lower().replace("_", "-")
        if key in IMPLICIT_RUNTIME_DEPS:
            continue
        modules = dist_to_modules.get(key)
        if modules is None:
            # Not installed here: a different failure, and the import check in CI
            # catches it. Not this gate's business.
            continue
        if not (modules & imported):
            unused.append(f"{dep} (installs {sorted(modules)}, none imported by app/)")

    assert not unused, (
        "declared as runtime dependencies and shipped in the bundle, but nothing "
        "in app/ imports them. Drop them, or add them to IMPLICIT_RUNTIME_DEPS "
        "WITH the name of the library that reaches them:\n  " + "\n  ".join(unused))
