# src-tauri

Tauri v2 desktop shell for Storage Agent Workbench.

## Bundled sidecar

The Python sidecar is a PyInstaller **one-dir** bundle shipped as a Tauri
**resource** (`bundle.resources` in `tauri.conf.json` maps
`sidecar-dist/storage-agent-sidecar` → `sidecar/`), and launched directly with
`std::process::Command` from `src/lib.rs` — not `externalBin`,
`tauri-plugin-shell`, or any one-file binary. One-dir keeps the libraries at a
stable path so macOS Gatekeeper scans them once (fast cold start); see
[../docs/packaging.md](../docs/packaging.md).

- On startup `lib.rs` resolves the sidecar inside the app's resource dir, picks a
  free localhost port, spawns it with `--host 127.0.0.1 --port <free>` and
  `STORAGE_AGENT_DATA_DIR` set to the OS app-data dir, and stores the URL +
  child handle in `SidecarState`.
- The frontend calls the `get_sidecar_url` command to learn the URL (production);
  in dev it uses `VITE_SIDECAR_URL` / the default `http://127.0.0.1:8765`.
- The sidecar child is killed on app exit. The only spawned process is this
  internal sidecar — there is no user-facing shell/subprocess command.

### Building the bundled sidecar

The release/build scripts produce the one-dir bundle and stage it under
`src-tauri/sidecar-dist/` before the Tauri build; see
`scripts/build-sidecar-for-tauri.py` and the platform build scripts under
`scripts/`.

## Build

Tauri requires the Rust toolchain (`cargo`, `rustc`) and platform webview
prerequisites. CI builds the desktop app for macOS (arm64), Linux (x64), and
Windows (x64) on every push and release.

```bash
cargo install tauri-cli --version "^2"
cargo tauri build    # or: cargo tauri dev
```

## Signing & notes

- `bundle.active` is `true`; the macOS bundle is **ad-hoc deep-signed** (no
  hardened runtime, not notarized) — see [../docs/signing.md](../docs/signing.md).
- No custom Tauri commands beyond `get_sidecar_url`; no user shell access.
- No auto-update yet.
