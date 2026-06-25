// Phase 08: Tauri v2 shell that launches the bundled Python sidecar and exposes
// its URL to the frontend. Still no custom S3 logic, no shell access for the
// user, no destructive operations — the only spawned process is the internal
// packaged sidecar.
//
// NOTE: This Rust code is not compiled in environments without the Rust
// toolchain (a documented packaging blocker). It follows the standard Tauri v2
// sidecar pattern via tauri-plugin-shell.

use std::net::TcpListener;
use std::sync::Mutex;

use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Holds the resolved sidecar URL and the child process handle.
struct SidecarState {
    url: String,
    child: Mutex<Option<CommandChild>>,
}

/// Pick a free localhost TCP port by binding to port 0 and reading it back.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(8765)
}

/// Frontend calls this (in production) to learn where the sidecar is listening.
#[tauri::command]
fn get_sidecar_url(state: State<SidecarState>) -> String {
    state.url.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = free_port();
            let url = format!("http://127.0.0.1:{port}");

            // App data dir is the stable, OS-appropriate location for user data.
            let data_dir = app
                .path()
                .app_data_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            // Spawn the bundled sidecar (externalBin "binaries/storage-agent-sidecar").
            let sidecar = app
                .shell()
                .sidecar("storage-agent-sidecar")
                .expect("failed to create sidecar command")
                .args(["--host", "127.0.0.1", "--port", &port.to_string()])
                .env("STORAGE_AGENT_DATA_DIR", data_dir);

            let (_rx, child) = sidecar.spawn().expect("failed to spawn sidecar");

            app.manage(SidecarState {
                url,
                child: Mutex::new(Some(child)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_sidecar_url])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Clean up the sidecar process when the app exits.
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    if let Some(child) = state.child.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
