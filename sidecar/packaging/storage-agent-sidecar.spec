# PyInstaller spec for the Storage Agent sidecar (Phase 08).
#
# Build (from the sidecar/ directory):
#     python packaging/build_sidecar.py
# or directly:
#     pyinstaller packaging/storage-agent-sidecar.spec --noconfirm \
#         --distpath dist --workpath build/pyinstaller
#
# Produces a one-dir bundle at: sidecar/dist/storage-agent-sidecar/
#
# Security: this spec bundles ONLY code + library data. It must never include
# .env, the SQLite DB, keyring contents, or data/runs output (see `excludes`
# and the fact that only the `app` package is the entry graph).

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = []
binaries = []
hiddenimports = []

# Packages with C extensions / data files that need full collection.
for pkg in ("duckdb", "pyarrow", "pandas"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# Dynamically/lazily imported at runtime (e.g. the Agents SDK is imported inside
# a function, uvicorn loads its loop/protocol implementations by name).
hiddenimports += collect_submodules("uvicorn")
hiddenimports += [
    "app.main",
    "openai",
    "agents",
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
    exclude_binaries=True,
    name="storage-agent-sidecar",
    console=True,
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
