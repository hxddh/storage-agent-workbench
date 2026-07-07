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
  free localhost port, generates a random per-launch auth token, and spawns the
  sidecar with `--host 127.0.0.1 --port <free>` plus three env vars:
  `STORAGE_AGENT_DATA_DIR` (the OS app-data dir), `STORAGE_AGENT_AUTH_TOKEN`
  (the shared secret the sidecar then requires on every request), and
  `STORAGE_AGENT_PARENT_PID` (so the sidecar exits if the app dies). The URL,
  token, and child handle live in `SidecarState`.
- The frontend calls the `get_sidecar_url` command to learn the URL and
  `get_sidecar_token` to learn the auth token it must send as the
  `X-Sidecar-Token` header (`?token=` for SSE) — production only; in dev it uses
  `VITE_SIDECAR_URL` / the default `http://127.0.0.1:8765` with auth open.
- The sidecar child is killed on app exit. The only spawned process is this
  internal sidecar — there is no user-facing shell/subprocess command.

### Building the bundled sidecar

The release/build scripts produce the one-dir bundle and stage it under
`src-tauri/sidecar-dist/` before the Tauri build; see
`scripts/build-sidecar-for-tauri.py` and the platform build scripts under
`scripts/`.

## Build

Tauri requires the Rust toolchain (`cargo`, `rustc`) and platform webview
prerequisites. The per-push CI workflow (`.github/workflows/ci.yml`) gates the
frontend build, sidecar tests, and a macOS (arm64) desktop build; Linux (x64)
and Windows (x64) desktop builds and the sidecar packaging job run as
informational (`continue-on-error`) jobs. Release installers for all three
platforms are produced by the manually dispatched `Release` workflow — see
[../docs/release.md](../docs/release.md).

```bash
cargo install tauri-cli --version "^2"
cargo tauri build    # or: cargo tauri dev
```

## Signing & notes

- `bundle.active` is `true`; the macOS bundle is **ad-hoc deep-signed** (no
  hardened runtime, not notarized) — see [../docs/signing.md](../docs/signing.md).
- The only custom Tauri commands are `get_sidecar_url` and `get_sidecar_token`;
  no user shell access.
- No auto-update yet.
