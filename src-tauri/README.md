# src-tauri

Tauri v2 desktop shell for Storage Agent Workbench.

## Phase 08: bundled sidecar

The desktop app launches the packaged Python sidecar via Tauri's sidecar
support (`tauri-plugin-shell`):

- On startup it picks a free localhost port, spawns
  `binaries/storage-agent-sidecar`, and passes `--host 127.0.0.1 --port <free>`
  plus `STORAGE_AGENT_DATA_DIR` set to the OS app-data dir.
- The frontend calls the `get_sidecar_url` command to learn the URL (production);
  in dev it uses `VITE_SIDECAR_URL` / the default `http://127.0.0.1:8765`.
- The sidecar child process is killed on app exit.

### Placing the sidecar binary

`bundle.externalBin` expects a target-triple-suffixed binary under
`src-tauri/binaries/`. After building the sidecar:

```bash
cd ../sidecar && python packaging/build_sidecar.py   # one-file -> dist/storage-agent-sidecar
# copy the executable to the expected name, e.g. on Apple Silicon:
mkdir -p ../src-tauri/binaries
cp dist/storage-agent-sidecar \
   ../src-tauri/binaries/storage-agent-sidecar-aarch64-apple-darwin
```

(Use `rustc -Vv | grep host` to get your target triple.)

## Requirements / status

Tauri requires the Rust toolchain (`cargo`, `rustc`) and platform webview
prerequisites. **As of Phase 08 the Rust toolchain is not installed in this
environment**, so `cargo tauri dev` / `cargo tauri build` have not been run or
verified here. The Rust integration code follows the standard Tauri v2 sidecar
pattern; build it on a machine with Rust installed:

```bash
cargo install tauri-cli --version "^2"
cargo tauri dev    # or: cargo tauri build
```

## Notes

- `bundle.active` is `false` so a release bundle does not require icon assets yet.
- No custom Tauri commands beyond `get_sidecar_url`; no user shell access.
- No code signing / notarization and no auto-update in Phase 08.
