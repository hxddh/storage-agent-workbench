# src-tauri

Tauri v2 desktop shell for Storage Agent Workbench.

Phase 01 is a minimal shell that loads the React/Vite frontend. It does **not**
yet spawn the Python sidecar; future phases will package the sidecar with
PyInstaller and launch it via Tauri's sidecar (`externalBin`) support.

## Requirements

Tauri requires the Rust toolchain (`cargo`, `rustc`) and the platform webview
prerequisites. Install Rust via <https://rustup.rs> and the Tauri CLI:

```bash
cargo install tauri-cli --version "^2"
```

## Run (dev)

From this directory:

```bash
cargo tauri dev
```

This runs `beforeDevCommand` (the frontend dev server on `127.0.0.1:1420`) and
opens the desktop window.

## Notes

- `bundle.active` is set to `false` in `tauri.conf.json` so a release bundle does
  not require icon assets during Phase 01.
- No custom Tauri commands, no shell access, no S3 logic in this phase.
