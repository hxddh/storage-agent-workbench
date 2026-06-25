// Phase 01: minimal Tauri v2 shell that loads the React/Vite frontend.
// No custom commands, no sidecar spawning, no S3 logic, no shell access.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
