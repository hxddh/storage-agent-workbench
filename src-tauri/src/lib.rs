// Tauri v2 shell that launches the bundled Python sidecar and exposes its URL to
// the frontend. No custom S3 logic, no shell access for the user, no destructive
// operations — the only spawned process is the internal packaged sidecar.
//
// The sidecar is a PyInstaller ONE-DIR bundle shipped as a Tauri resource
// (tauri.conf.json `bundle.resources`). We launch the inner executable directly
// with std::process::Command from the resolved resource directory. One-dir is
// used (instead of one-file + `externalBin`) because a one-file build
// self-extracts on every launch and macOS Gatekeeper re-scans the extracted libs
// each time — making cold start ~60s. One-dir keeps the libraries at a stable
// path scanned once, so cold start drops to ~the Python import time.
//
// NOTE: This Rust code is not compiled in environments without the Rust
// toolchain (a documented packaging blocker).

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, State};

/// Holds the resolved sidecar URL, auth token, and the child process handle.
struct SidecarState {
    url: String,
    token: String,
    child: Mutex<Option<Child>>,
}

/// Pick a free localhost TCP port by binding to port 0 and reading it back.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(8765)
}

/// Generate a random 128-bit auth token as 32 lowercase hex chars from the OS
/// CSPRNG. This token gates the webview↔sidecar loopback API (the sidecar
/// enforces it when the env var is set); for a *different local user* who can
/// reach 127.0.0.1 but cannot read this process's `/proc/<pid>/environ`, it is
/// the only barrier, so it must be unpredictable.
///
/// Uses `getrandom` (the OS CSPRNG: `getrandom(2)`/`/dev/urandom` on Unix,
/// `BCryptGenRandom` on Windows). Do NOT reconstruct this from the clock, pid,
/// or ephemeral ports — all are locally observable/low-entropy, which would make
/// the token guessable. If the CSPRNG is somehow unavailable we fail closed by
/// panicking rather than emitting a predictable token.
fn gen_token() -> String {
    let mut bytes = [0u8; 16]; // 128 bits
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG unavailable for auth token");
    let mut out = String::with_capacity(32);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Frontend calls this (in production) to learn where the sidecar is listening.
#[tauri::command]
fn get_sidecar_url(state: State<SidecarState>) -> String {
    state.url.clone()
}

/// Frontend calls this (in production) to learn the sidecar auth token to send
/// as the `X-Sidecar-Token` header (and `?token=` for SSE). Empty when unset.
#[tauri::command]
fn get_sidecar_token(state: State<SidecarState>) -> String {
    state.token.clone()
}

/// Executable name inside the one-dir bundle (`.exe` on Windows).
fn sidecar_exe_name() -> &'static str {
    if cfg!(windows) {
        "storage-agent-sidecar.exe"
    } else {
        "storage-agent-sidecar"
    }
}

/// Resolve the bundled sidecar executable inside the resource directory.
///
/// The `bundle.resources` map stages the one-dir folder under the app's resource
/// dir. Layout can vary slightly by platform/bundler, so probe the known
/// candidates and return the first that exists.
fn resolve_sidecar(resource_dir: &PathBuf) -> Option<PathBuf> {
    let exe = sidecar_exe_name();
    let candidates = [
        resource_dir.join("sidecar").join("storage-agent-sidecar").join(exe),
        resource_dir.join("sidecar").join(exe),
        resource_dir.join("storage-agent-sidecar").join(exe),
    ];
    candidates.into_iter().find(|p| p.exists())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let port = free_port();
            let url = format!("http://127.0.0.1:{port}");
            // Random per-launch auth token: the sidecar enforces it only because
            // we set STORAGE_AGENT_AUTH_TOKEN in its environment below.
            let token = gen_token();

            // App data dir is the stable, OS-appropriate location for user data.
            let data_dir = app
                .path()
                .app_data_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            let resource_dir = app
                .path()
                .resource_dir()
                .expect("failed to resolve resource dir");

            let sidecar_bin = resolve_sidecar(&resource_dir).unwrap_or_else(|| {
                panic!(
                    "bundled sidecar not found under resource dir {}",
                    resource_dir.display()
                )
            });

            let child = Command::new(&sidecar_bin)
                .args(["--host", "127.0.0.1", "--port", &port.to_string()])
                .env("STORAGE_AGENT_DATA_DIR", data_dir)
                // Auth token the sidecar requires on every request (header or
                // ?token= for SSE). Only enforced because it's set here.
                .env("STORAGE_AGENT_AUTH_TOKEN", &token)
                // The sidecar exits if this PID disappears, so the child is never
                // orphaned on app exit/crash.
                .env("STORAGE_AGENT_PARENT_PID", std::process::id().to_string())
                .spawn()
                .expect("failed to spawn sidecar");

            app.manage(SidecarState {
                url,
                token,
                child: Mutex::new(Some(child)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_sidecar_url, get_sidecar_token])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Clean up the sidecar process when the app exits.
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    if let Some(mut child) = state.child.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
