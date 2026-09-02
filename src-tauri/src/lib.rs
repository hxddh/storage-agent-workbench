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

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// The deep-link scheme registered in tauri.conf.json (`plugins.deep-link`).
const DEEP_LINK_SCHEME: &str = "storage-agent";
/// One global shortcut: summon the window and focus the Composer.
const SUMMON_SHORTCUT: &str = "CmdOrCtrl+Shift+S";
/// Menu commands the native menu bar dispatches to the webview as the
/// `menu-command` event `{ id }`. The frontend (`hooks/useNativeAgent.ts`,
/// `MENU_COMMANDS`) routes each id through the SAME handler the keyboard and
/// the command palette use — the menu is not a second command path.
/// (id, label, accelerator)
const MENU_COMMANDS: &[(&str, &str, Option<&str>)] = &[
    ("settings", "Settings…", Some("CmdOrCtrl+,")),
    ("new-task", "New Task", Some("CmdOrCtrl+N")),
    ("rename-task", "Rename Task", None),
    ("delete-task", "Delete Task…", None),
    ("stop", "Stop Execution", Some("CmdOrCtrl+.")),
    ("resume", "Resume Interrupted Execution", None),
    ("toggle-sidebar", "Toggle Sidebar", Some("CmdOrCtrl+\\")),
    ("find", "Find in Task", Some("CmdOrCtrl+F")),
    ("review", "Review Evidence", Some("CmdOrCtrl+I")),
    ("palette", "Command Palette", Some("CmdOrCtrl+K")),
    ("focus-composer", "Focus Composer", Some("CmdOrCtrl+L")),
    ("theme", "Toggle Theme", None),
    ("shortcuts", "Keyboard Shortcuts", None),
    ("release-notes", "Release Notes", None),
];

/// Holds the resolved sidecar URL, auth token, and the child process handle.
struct SidecarState {
    url: String,
    token: String,
    child: Mutex<Option<Child>>,
}

/// Pick a free localhost TCP port by binding to port 0 and reading it back.
///
/// Returns None rather than falling back to 8765: that is the documented DEV
/// default, so the fallback aimed the launcher straight at whatever is already
/// listening there — typically a stale sidecar from an earlier crashed run,
/// holding a different token and a different data dir. A launcher that cannot
/// find a port must fail loudly, not silently adopt a foreign process.
fn free_port() -> Option<u16> {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
}

/// Block until the sidecar we just spawned answers /health with OUR launch
/// nonce, or fail with a precise reason.
///
/// Two problems this closes. (1) Nothing checked that the child stayed alive:
/// a sidecar that exited at startup (port lost to the TOCTOU race below, an
/// unwritable data dir, a missing lib in the bundle) left the user staring at a
/// "starting…" spinner forever, because the frontend's health hook maps every
/// pre-first-success failure back to "starting". (2) Nothing checked WHO was
/// listening: the webview would send the auth token to any local process
/// squatting the port that could answer `{"status":"ok"}` — disclosing the
/// secret that exists to keep other local processes out. The nonce is echoed
/// only by a sidecar that inherited it from this launch.
/// One loopback GET /health. Deliberately a hand-rolled request over TcpStream
/// rather than an HTTP crate: this is the only HTTP the shell ever speaks, to a
/// fixed path on 127.0.0.1, so a client dependency would be pure supply-chain
/// surface for no benefit. Returns the response body.
fn probe_health(port: u16) -> Result<String, String> {
    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(2),
    )
    .map_err(|e| format!("{e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| format!("{e}"))?;
    stream
        .write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|e| format!("{e}"))?;
    let mut body = String::new();
    // HTTP/1.0 + Connection: close means the server closes at end of body, so a
    // read-to-end is the complete response (headers included — we only need to
    // substring-match the nonce, so no parsing is required).
    stream
        .take(64 * 1024)
        .read_to_string(&mut body)
        .map_err(|e| format!("{e}"))?;
    Ok(body)
}

fn await_sidecar_ready(
    port: u16,
    nonce: &str,
    child: &mut Child,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut last = String::from("no response yet");
    while Instant::now() < deadline {
        // A child that already exited will never become ready; report its status
        // instead of burning the whole timeout.
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "sidecar exited during startup with {status} (last probe: {last})"
            ));
        }
        match probe_health(port) {
            Ok(body) => {
                if body.contains(nonce) {
                    return Ok(());
                }
                // Something is listening, but it is not our sidecar.
                last = "a different process is listening on this port".to_string();
            }
            Err(e) => last = e,
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(format!("sidecar did not become ready within {timeout:?}: {last}"))
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
    // `fill` since getrandom 0.3 (the 0.2 spelling was `getrandom::getrandom`).
    getrandom::fill(&mut bytes).expect("OS CSPRNG unavailable for auth token");
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

/// Save app-generated text (a markdown report) into the user's Downloads
/// directory and return the written path. WKWebView ignores the `download`
/// attribute on blob: URLs, so the frontend's anchor-download was a silent
/// no-op on macOS — this core-only command (no plugins) is the reliable path.
/// The filename is reduced to a safe basename; existing files are never
/// overwritten (a numeric suffix is appended instead).
#[tauri::command]
fn save_report(app: tauri::AppHandle, filename: String, content: String) -> Result<String, String> {
    let safe: String = filename
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let safe = if safe.is_empty() { "report.md".to_string() } else { safe };
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("no downloads directory: {e}"))?;
    let (stem, ext) = match safe.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (safe.clone(), String::new()),
    };
    // create_new(true) is the whole guarantee: `exists()` then `write()` is
    // racy, and the old loop fell through to the ORIGINAL path when all 99
    // suffixes were taken — overwriting the user's file, the exact opposite of
    // what this function promises. Now the OS decides atomically and we simply
    // try the next name on AlreadyExists.
    for i in 0..1000 {
        let candidate = if i == 0 {
            dir.join(&safe)
        } else {
            dir.join(format!("{stem}-{i}{ext}"))
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut f) => {
                f.write_all(content.as_bytes())
                    .map_err(|e| format!("write failed: {e}"))?;
                return Ok(candidate.to_string_lossy().to_string());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("write failed: {e}")),
        }
    }
    Err(format!("could not find a free filename for {safe} in the downloads folder"))
}

/// Open an https/mailto link in the system browser/mail client. Tauri v2
/// swallows `target="_blank"` without the opener plugin, so links in agent
/// answers were dead in the packaged app. This is a UI-level opener, not a shell
/// tool: a strict scheme allowlist, no shell interpreter, and the URL is always
/// passed as a single argv argument to a non-shell launcher.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let ok = url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:");
    if !ok {
        return Err("only http(s)/mailto links can be opened".to_string());
    }
    // Defense in depth: a real URL never contains raw whitespace or control
    // characters (spaces are percent-encoded). Rejecting them blocks
    // newline/argument-splitting tricks before the URL reaches any handler.
    if url.chars().any(|c| c.is_control() || c == ' ') {
        return Err("URL contains illegal whitespace or control characters".to_string());
    }
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&url).spawn();
    // Windows: NOT `cmd /C start`. cmd.exe reparses its argument string and treats
    // `& | < > ^` as metacharacters, and Rust's std cannot safely escape for
    // cmd/batch — so a link like `https://x/&calc.exe` would run an arbitrary
    // command (and `&` is legitimate in URL query strings, so it can't be
    // filtered out). `rundll32 url.dll,FileProtocolHandler` is a normal
    // executable: the URL is passed as one properly-escaped argv arg with no
    // shell reparse, and url.dll handles http/https/mailto via the default apps.
    #[cfg(target_os = "windows")]
    let result = Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(&url)
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&url).spawn();
    result.map(|_| ()).map_err(|e| format!("open failed: {e}"))
}

/// `storage-agent://task/<id>` or `storage-agent://open?task=<id>` → the task
/// id, or None for anything else. Ids are opaque hex/uuid-ish tokens; anything
/// with other characters is rejected here before it reaches the webview.
fn deep_link_task_id(url: &str) -> Option<String> {
    let rest = url.strip_prefix(&format!("{DEEP_LINK_SCHEME}://"))?;
    let (path, query) = match rest.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (rest, None),
    };
    let path = path.trim_matches('/');
    let id = if let Some(id) = path.strip_prefix("task/") {
        id.trim_matches('/').to_string()
    } else if path == "open" || path.is_empty() {
        query?
            .split('&')
            .find_map(|kv| kv.strip_prefix("task=").map(|v| v.to_string()))?
    } else {
        return None;
    };
    let ok = id.len() >= 8
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(id)
}

/// Deep-link URLs among a process's argv (Windows/Linux hand them over as an
/// argument; macOS uses the open-url event instead).
fn deep_links_in_argv(argv: &[String]) -> Vec<String> {
    argv.iter()
        .filter(|a| a.starts_with(&format!("{DEEP_LINK_SCHEME}://")))
        .cloned()
        .collect()
}

/// Surface the window and hand the URLs to the webview as ONE event; the
/// frontend extracts the task id with the same rules as `deep_link_task_id`.
fn emit_deep_links<R: Runtime>(app: &AppHandle<R>, urls: Vec<String>) {
    let urls: Vec<String> = urls
        .into_iter()
        .filter(|u| deep_link_task_id(u).is_some())
        .collect();
    if urls.is_empty() {
        return;
    }
    focus_main_window(app);
    let _ = app.emit("deep-link-request", serde_json::json!({ "urls": urls }));
}

fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    let win = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next());
    if let Some(win) = win {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// App · Task · View · Help. Every custom item carries one of MENU_COMMANDS;
/// the predefined Edit/Window items are what keep copy/paste and window
/// management native inside the webview.
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str| -> tauri::Result<MenuItem<R>> {
        let (_, label, accel) = MENU_COMMANDS
            .iter()
            .find(|(cid, _, _)| *cid == id)
            .copied()
            .expect("menu id is declared in MENU_COMMANDS");
        MenuItem::with_id(app, id, label, true, accel)
    };
    let app_menu = Submenu::with_items(
        app,
        "Storage Agent",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Storage Agent"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("settings")?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("find")?,
        ],
    )?;
    let task_menu = Submenu::with_items(
        app,
        "Task",
        true,
        &[
            &item("new-task")?,
            &item("rename-task")?,
            &item("delete-task")?,
            &PredefinedMenuItem::separator(app)?,
            &item("stop")?,
            &item("resume")?,
            &PredefinedMenuItem::separator(app)?,
            &item("review")?,
            &item("focus-composer")?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("toggle-sidebar")?,
            &item("palette")?,
            &item("theme")?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[&item("shortcuts")?, &item("release-notes")?],
    )?;
    Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &task_menu, &view_menu, &window_menu, &help_menu],
    )
}

/// One OS notification (title + body). Text only; the webview decides when a
/// settled background Execution deserves one.
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    let clip = |s: String, n: usize| -> String { s.chars().take(n).collect() };
    app.notification()
        .builder()
        .title(clip(title, 120))
        .body(clip(body, 400))
        .show()
        .map_err(|e| format!("notification failed: {e}"))
}

/// The OS window title (`<task> — Storage Agent`).
#[tauri::command]
fn set_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    let title: String = title.chars().take(200).collect();
    window
        .set_title(&title)
        .map_err(|e| format!("set title failed: {e}"))
}

/// Reveal one folder under the app data directory in the OS file manager.
/// Only named subfolders are allowed (today: `skills`); the folder is created
/// if missing so the user can drop a SKILL.md straight in. Not a filesystem
/// tool: no arbitrary path, no read, no write beyond `create_dir_all`.
#[tauri::command]
fn open_app_folder(app: tauri::AppHandle, sub: String) -> Result<String, String> {
    let sub = match sub.as_str() {
        "skills" => "skills",
        _ => return Err("unknown app folder".to_string()),
    };
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join(sub);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create folder: {e}"))?;
    let shown = dir.to_string_lossy().to_string();
    app.opener()
        .open_path(shown.clone(), None::<&str>)
        .map_err(|e| format!("open failed: {e}"))?;
    Ok(shown)
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
        // MUST be the first plugin registered (the plugin's own requirement):
        // a second launch hands its argv to the running instance and exits,
        // rather than starting a second sidecar over the SAME data dir. That
        // sharing is not benign — the secret vault rewrites the whole file on
        // every save, so the second instance's write silently discarded a
        // credential the first had just stored, and both would contend on one
        // app.db. Here we simply surface the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // The window config sets no explicit label, so Tauri's implicit
            // "main" applies — but don't depend on that: fall back to whichever
            // window exists so a future label rename can't silently turn the
            // second launch into a no-op the user reads as "the app is dead".
            focus_main_window(app);
            // A second launch triggered by a `storage-agent://` link carries
            // the URL in argv (Windows/Linux); hand it to the running window.
            emit_deep_links(app, deep_links_in_argv(&argv));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .menu(|app| build_menu(app))
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            if MENU_COMMANDS.iter().any(|(cid, _, _)| *cid == id) {
                let _ = app.emit("menu-command", serde_json::json!({ "id": id }));
            }
        })
        .setup(|app| {
            // Deep links: the OS open-url event (macOS, and Linux/Windows once
            // the scheme is registered) → one `deep-link-request` event. On
            // Linux/Windows dev builds the scheme is registered at runtime so
            // the link works before an installer ever ran.
            #[cfg(any(windows, target_os = "linux"))]
            {
                let _ = app.deep_link().register_all();
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                emit_deep_links(&handle, urls);
            });
            // Cold start with a link in argv (Windows/Linux).
            let argv: Vec<String> = std::env::args().collect();
            let startup_links = deep_links_in_argv(&argv);
            if !startup_links.is_empty() {
                let handle = app.handle().clone();
                // The webview is not listening yet; it asks `get_current` on
                // mount, and we also re-emit shortly after for good measure.
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    emit_deep_links(&handle, startup_links);
                });
            }
            // Global summon shortcut. Best-effort: another app may own it.
            let summon = app.handle().clone();
            let _ = app
                .global_shortcut()
                .on_shortcut(SUMMON_SHORTCUT, move |_app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        focus_main_window(&summon);
                        let _ = summon.emit(
                            "shortcut-event",
                            serde_json::json!({ "shortcut": SUMMON_SHORTCUT }),
                        );
                    }
                });

            let port = free_port().ok_or_else(|| {
                eprintln!("fatal: no free loopback port for the sidecar");
                "no free loopback port for the sidecar".to_string()
            })?;
            let url = format!("http://127.0.0.1:{port}");
            // Random per-launch auth token: the sidecar enforces it only because
            // we set STORAGE_AGENT_AUTH_TOKEN in its environment below.
            let token = gen_token();
            // Separate per-launch value, NOT a secret: the sidecar echoes it on
            // /health so we can prove the process on `port` is the one we
            // started before handing the webview the URL and the real token.
            let nonce = gen_token();

            // App data dir is the stable, OS-appropriate location for user data.
            // A failure here must abort startup, not degrade to an empty string:
            // the sidecar treats "" as unset and falls back to a path INSIDE the
            // packaged bundle, writing the SQLite DB and the secret vault into
            // the signed app (breaking the seal, losing everything on update).
            let data_dir = app
                .path()
                .app_data_dir()
                .map(|p| p.to_string_lossy().to_string())
                .map_err(|e| {
                    eprintln!("fatal: failed to resolve app data dir: {e}");
                    format!("failed to resolve app data dir: {e}")
                })?;

            // Launch failures below return an Err from `setup` instead of
            // `panic!`/`.expect()`. A panic here unwinds through the Tauri/FFI
            // boundary and shows the user an opaque crash; returning the error
            // lets Tauri report it cleanly and still aborts startup (the app
            // cannot function without its sidecar). We also log a precise
            // diagnostic to stderr so a packaging regression is debuggable.
            let resource_dir = app.path().resource_dir().map_err(|e| {
                eprintln!("fatal: failed to resolve resource dir: {e}");
                format!("failed to resolve resource dir: {e}")
            })?;

            let sidecar_bin = resolve_sidecar(&resource_dir).ok_or_else(|| {
                eprintln!(
                    "fatal: bundled sidecar not found under resource dir {}",
                    resource_dir.display()
                );
                format!(
                    "bundled sidecar not found under resource dir {}",
                    resource_dir.display()
                )
            })?;

            let mut child = Command::new(&sidecar_bin)
                .args(["--host", "127.0.0.1", "--port", &port.to_string()])
                .env("STORAGE_AGENT_DATA_DIR", data_dir)
                // Auth token the sidecar requires on every request (header or
                // ?token= for SSE). Only enforced because it's set here.
                .env("STORAGE_AGENT_AUTH_TOKEN", &token)
                // Non-secret identity value echoed on /health (see below).
                .env("STORAGE_AGENT_LAUNCH_NONCE", &nonce)
                // The sidecar exits if this PID disappears, so the child is never
                // orphaned on app exit/crash.
                .env("STORAGE_AGENT_PARENT_PID", std::process::id().to_string())
                .spawn()
                .map_err(|e| {
                    eprintln!("fatal: failed to spawn sidecar at {}: {e}", sidecar_bin.display());
                    format!("failed to spawn sidecar at {}: {e}", sidecar_bin.display())
                })?;

            // Don't publish the URL/token until OUR sidecar has answered on that
            // port. Without this the app could hand the token to a foreign
            // listener, or hang on a "starting…" spinner forever after a sidecar
            // that died at startup. Kill the child on failure so a half-started
            // process is never left behind.
            if let Err(e) = await_sidecar_ready(port, &nonce, &mut child, Duration::from_secs(60)) {
                let _ = child.kill();
                eprintln!("fatal: {e}");
                return Err(e.into());
            }

            app.manage(SidecarState {
                url,
                token,
                child: Mutex::new(Some(child)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_sidecar_url, get_sidecar_token,
                                                 save_report, open_external, notify,
                                                 set_window_title, open_app_folder])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Clean up the sidecar process when the app exits. BOTH terminal
            // events are handled: ExitRequested alone missed the paths that
            // don't ask first (a window-manager close, an OS logout), leaving
            // teardown entirely to the child's own parent-watchdog. `Option::take`
            // makes the second call a no-op, so handling both is safe.
            //
            // `lock()` is matched, never unwrapped: a poisoned mutex here would
            // panic *during shutdown*, inside the run-event callback, turning a
            // clean exit into a crash — and the child watchdog would still reap
            // the sidecar anyway.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            // Reap so the child is never left a zombie if the
                            // host process lingers after this event.
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_link_task_paths_resolve() {
        assert_eq!(
            deep_link_task_id("storage-agent://task/0123456789abcdef"),
            Some("0123456789abcdef".to_string())
        );
        assert_eq!(
            deep_link_task_id("storage-agent://open?task=abcdef01&x=1"),
            Some("abcdef01".to_string())
        );
        assert_eq!(deep_link_task_id("storage-agent://task/short"), None);
        assert_eq!(deep_link_task_id("storage-agent://task/../etc"), None);
        assert_eq!(deep_link_task_id("https://example.com/task/0123456789"), None);
        assert_eq!(deep_link_task_id("storage-agent://settings"), None);
    }

    #[test]
    fn argv_deep_links_are_picked_out() {
        let argv = vec![
            "app".to_string(),
            "--flag".to_string(),
            "storage-agent://task/0123456789abcdef".to_string(),
        ];
        assert_eq!(deep_links_in_argv(&argv).len(), 1);
        assert!(deep_links_in_argv(&["app".to_string()]).is_empty());
    }

    #[test]
    fn menu_command_ids_are_unique_and_kebab_case() {
        let mut seen = std::collections::HashSet::new();
        for (id, label, _) in MENU_COMMANDS {
            assert!(seen.insert(*id), "duplicate menu id {id}");
            assert!(id.chars().all(|c| c.is_ascii_lowercase() || c == '-'));
            assert!(!label.is_empty());
        }
    }
}
