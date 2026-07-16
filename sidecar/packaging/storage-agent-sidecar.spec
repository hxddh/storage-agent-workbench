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

from PyInstaller.utils.hooks import collect_all, collect_submodules

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
for pkg in ("duckdb", "pyarrow", "pandas", "openai", "agents", "griffe",
            "boto3", "botocore", "cryptography"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# Dynamically/lazily imported at runtime (uvicorn loads its loop/protocol
# implementations by name; keyring resolves backends by name).
hiddenimports += collect_submodules("uvicorn")
hiddenimports += [
    "app.main",
    "keyring.backends",
]

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
