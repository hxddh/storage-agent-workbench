# PyInstaller spec for the Storage Agent sidecar (Phase 08).
#
# Build (from the sidecar/ directory):
#     python packaging/build_sidecar.py
# or directly:
#     pyinstaller packaging/storage-agent-sidecar.spec --noconfirm \
#         --distpath dist --workpath build/pyinstaller
#
# Produces a ONE-DIR bundle at: sidecar/dist/storage-agent-sidecar/
# (the `storage-agent-sidecar` executable plus an `_internal/` folder of libs).
#
# One-DIR (not one-file) is deliberate: a one-file build self-extracts its whole
# archive to a fresh temp dir on EVERY launch, and on macOS Gatekeeper then
# re-scans every extracted Mach-O at that new path — making cold start ~60s.
# One-dir keeps the libraries at a stable path inside the app bundle (scanned
# once), so cold start drops to ~the Python import time. The Tauri app bundles
# this folder as a resource and launches the inner executable directly (see
# src-tauri/src/lib.rs); it is NOT wired through `externalBin`, which only
# supports a single file.
#
# Security: this spec bundles ONLY code + library data. It must never include
# .env, the SQLite DB, keyring contents, or data/runs output (see `excludes`
# and the fact that only the `app` package is the entry graph).

from pathlib import Path

import os

from PyInstaller.utils.hooks import collect_all, collect_submodules, copy_metadata

datas = []
binaries = []
hiddenimports = []

# Bundled StorageOps skill pack (Phase 19): registry + SKILL.md guidance docs
# ONLY (no scripts/references/templates/CLI are vendored in the source tree, so
# copying the directory cannot pull them in). The loader resolves this at
# `app/bundled_skillpacks/...` relative to the `app` package, which is where
# PyInstaller extracts this data entry (matches Path(__file__)/../bundled... at
# runtime, including under sys._MEIPASS for the one-file build).
_skillpack = (Path(SPECPATH) / ".." / "app" / "bundled_skillpacks").resolve()
if _skillpack.is_dir():
    datas += [(str(_skillpack), "app/bundled_skillpacks")]

# Packages with C extensions / data files, or that import submodules lazily and
# must be collected in FULL (submodules + data + dylibs). The OpenAI Agents SDK
# (`agents`) and `openai` import submodules at package-import time, so listing
# them as bare hiddenimports is not enough — the one-file bundle then fails with
# "OpenAI Agents SDK is not available in this environment." griffe is used by the
# SDK to build tool schemas from docstrings.
# boto3/botocore are the core S3 SDK: botocore ships a large `botocore/data`
# tree of service JSON models loaded lazily by name, and both packages import
# submodules dynamically. Collect them in FULL rather than relying solely on
# PyInstaller's built-in hooks, so a bundle can never be missing an S3 service
# model at runtime (the deep self-check below exercises a real client build).
# cryptography backs the AES-256-GCM secret vault (security/keyring_store); it
# ships a compiled `_rust` binding loaded lazily, so collect it in FULL rather
# than trusting the built-in hook — a bundle that can't decrypt the vault would
# be a security-floor break that a bare /health probe never notices.
# Filtered AFTER Analysis, not here: pyinstaller-hooks-contrib ships its own
# pyarrow hook that collects these independently of this loop, so dropping them
# from `collect_all`'s output changes nothing (measured — the rebuilt bundle was
# byte-for-byte the same size). The TOC filter below is the only place that
# actually decides what ships.
for pkg in ("duckdb", "pyarrow", "pandas", "openai", "agents", "griffe",
            "boto3", "botocore", "cryptography"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# Dynamically/lazily imported at runtime: uvicorn loads its loop/protocol
# implementations by name, so they are invisible to static analysis.
#
# `keyring.backends` used to be forced in here too. It was a fossil: secrets
# moved to the self-managed AES-256-GCM vault (`security/keyring_store`, a
# module of ours that merely shares the word) and the OS keychain is something
# the security rules explicitly refuse. The packaging was still pulling in the
# backend machinery for it — along with jeepney and secretstorage, whose whole
# job is talking to that keychain. Removed with the dependency itself.
# METADATA ONLY, deliberately not the package. openai-agents 0.22 resolves the
# installed `mcp` version through importlib.metadata at import time; a frozen
# bundle carries no dist-info unless it is collected, so without this the SDK
# raises PackageNotFoundError and the agent runtime is dead in the packaged app
# while /health still answers 200 — which is why the deep self-check below
# exists, and it is what caught this on the openai 2->3 / agents 0.20->0.22 bump.
#
# `collect_all("mcp")` is the wrong tool twice over: it imports `mcp.cli`, which
# needs the optional `typer` we do not install (the build dies), and an MCP
# RUNTIME is explicitly out of scope for this product. Only the dist-info is
# needed, and only the dist-info is taken.
datas += copy_metadata("mcp")

hiddenimports += collect_submodules("uvicorn")
hiddenimports += ["app.main"]

block_cipher = None

a = Analysis(
    ["../app/packaged_main.py"],
    pathex=[".."],  # so `import app...` resolves to sidecar/app
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # Never bundle local user data or secrets.
    excludes=["tkinter", "tests"],
    noarchive=False,
)

# --- drop shared libraries nothing in this product links ---------------------
#
# Arrow ships its optional engines as separate shared libraries and the hooks
# take the lot. Flight is Arrow's gRPC-based network RPC stack — 28.6 MB, and it
# arrives TWICE (once from the package data, once from PyInstaller's binary
# analysis), so 57 MB of a download the user waits for. Nothing here links it:
# checked with `ldd` against both `pyarrow/lib*.so` and `pyarrow/_parquet*.so`,
# which between them pull libarrow, libarrow_acero, libarrow_compute,
# libarrow_dataset, libarrow_python and libarrow_substrait — and not Flight. The
# product's entire use of pyarrow is `pyarrow.parquet` plus one table in the
# self-check. A network RPC stack inside an app whose rules forbid unbounded
# network I/O is worth removing even at zero bytes.
#
# `libarrow_substrait` LOOKS equally severable and is NOT — ldd shows both
# extension modules link it, so it stays. This is a checked name list, not a
# "drop anything that sounds optional" pattern.
#
# It has to happen HERE rather than at collect_all: pyinstaller-hooks-contrib
# ships its own pyarrow hook that collects these independently, so filtering the
# collect_all output changed nothing (measured: same 553 MB).
# Matched on the STEM, with any `lib` prefix stripped first, because the same
# library is named three ways: `libarrow_flight.so.2500` (Linux),
# `libarrow_flight.dylib` (macOS), `arrow_flight.dll` + `arrow_flight.lib`
# (Windows — no `lib` prefix, which a naive prefix match silently misses, and
# the Windows job builds this same spec).
_UNUSED_LIB_STEMS = ("arrow_flight", "arrow_python_flight")


def _stem(dest) -> str:
    name = os.path.basename(str(dest))
    return name[3:] if name.startswith("lib") else name


def _without_unused_libs(toc):
    return [e for e in toc if not _stem(e[0]).startswith(_UNUSED_LIB_STEMS)]


_removed = {stem: 0 for stem in _UNUSED_LIB_STEMS}
for _toc in (a.binaries, a.datas):
    for _entry in _toc:
        for _stem_name in _UNUSED_LIB_STEMS:
            if _stem(_entry[0]).startswith(_stem_name):
                _removed[_stem_name] += 1
a.binaries = _without_unused_libs(a.binaries)
a.datas = _without_unused_libs(a.datas)
print(f"spec: dropped {sum(_removed.values())} unused shared-library entries "
      f"({', '.join(f'{k}={v}' for k, v in _removed.items())})")

# A saving that silently becomes a no-op is worse than no saving: it reads as
# done in the changelog while the installer keeps the weight. If a name stops
# matching — pyarrow renames it, or a platform spells it a fourth way — say so
# at BUILD time instead of shipping quietly.
_missing = [stem for stem, count in _removed.items() if count == 0]
if _missing:
    raise SystemExit(
        "storage-agent-sidecar.spec: expected to drop " + ", ".join(_missing) +
        " but found no matching entry. Either pyarrow no longer ships it (remove "
        "the name from _UNUSED_LIB_STEMS, deliberately) or it is spelled "
        "differently on this platform (add that spelling). Do not leave this "
        "silently matching nothing.")


# --- botocore ships 434 service models; this product speaks one --------------
#
# `collect_all("botocore")` takes the whole `botocore/data` tree: 27 MB of JSON
# API models for every AWS service that exists. The product builds exactly two
# boto3 clients (`s3/client_factory.py` and the health self-check) and both are
# S3. Instrumenting `Loader.load_service_model` while building a real client
# shows precisely what it reaches for: `s3/endpoint-rule-set-1` and
# `s3/service-2`, over the top-level `endpoints.json` / `partitions.json` /
# `_retry.json` / `sdk-default-configuration.json`.
#
# So keep the top-level files and the `s3/` directory, drop the other 433. The
# whole reason the FULL collect exists (see above) is that botocore loads models
# lazily BY NAME and PyInstaller cannot see it — that argument is about the S3
# model being present, not about shipping Kinesis. If a future feature needs
# another service, this list is where it is declared, and the deep self-check
# below builds a real client so a missing model fails the build rather than a
# user's first call.
_KEEP_BOTOCORE_SERVICES = ("s3",)


def _needed_botocore_data(entry) -> bool:
    dest = str(entry[0]).replace(os.sep, "/")
    marker = "botocore/data/"
    if marker not in dest:
        return True
    tail = dest.split(marker, 1)[1]
    if "/" not in tail:          # endpoints.json, partitions.json, _retry.json…
        return True
    return tail.split("/", 1)[0] in _KEEP_BOTOCORE_SERVICES


_before_data = len(a.datas)
a.datas = [e for e in a.datas if _needed_botocore_data(e)]
print(f"spec: dropped {_before_data - len(a.datas)} botocore service-model files "
      f"(kept: {', '.join(_KEEP_BOTOCORE_SERVICES)})")

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # one-dir: libraries live in the COLLECT folder
    name="storage-agent-sidecar",
    console=True,
    strip=False,
    upx=False,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="storage-agent-sidecar",
)
