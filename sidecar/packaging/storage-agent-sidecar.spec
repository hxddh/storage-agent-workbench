# PyInstaller spec for the Storage Agent sidecar (Phase 08).
#
# Build (from the sidecar/ directory):
#     python packaging/build_sidecar.py
# or directly:
#     pyinstaller packaging/storage-agent-sidecar.spec --noconfirm \
#         --distpath dist --workpath build/pyinstaller
#
# Produces a ONE-FILE binary at: sidecar/dist/storage-agent-sidecar
#
# One-file is used so the binary fits Tauri's `externalBin` (a single
# target-triple-suffixed file copied to src-tauri/binaries/). Trade-off: a
# one-file build self-extracts on each launch, so cold start is slower.
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
for pkg in ("duckdb", "pyarrow", "pandas", "openai", "agents", "griffe"):
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
    a.binaries,
    a.datas,
    [],
    name="storage-agent-sidecar",
    console=True,
    onefile=True,
    strip=False,
    upx=False,
    disable_windowed_traceback=False,
)
