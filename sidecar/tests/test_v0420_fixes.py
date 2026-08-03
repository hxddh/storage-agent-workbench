"""v0.42.0 — desktop-shell hardening + teaching drift.

The Rust-side fixes (readiness/identity probe, teardown, save_report) are
verified by `cargo check`/`clippy` and can't be exercised from pytest. What IS
testable here is the Python half of the shell contract plus the drift fixes:

  W1  the parent watchdog never calls os.kill on Windows — CPython maps signal 0
      there to TerminateProcess, so the watchdog KILLED the app it guards.
  W2  /health echoes the launcher's per-launch nonce (and omits it when unset),
      which is how the shell proves the process on its port is its own sidecar.
  W3  the packaged webview origins Tauri v2 uses on Windows are CORS-allowed.
  S1  survey_account's advertised max_buckets range matches the schema it feeds.
"""

from __future__ import annotations

import importlib
import inspect


# --- W1: the Windows watchdog must not use os.kill -------------------------

def test_watchdog_never_calls_os_kill_on_windows():
    from app import packaged_main

    import ast
    import textwrap

    src = textwrap.dedent(inspect.getsource(packaged_main._start_parent_watchdog))
    tree = ast.parse(src)

    def _calls_os_kill(fn: ast.FunctionDef) -> bool:
        return any(
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute)
            and n.func.attr == "kill"
            and isinstance(n.func.value, ast.Name)
            and n.func.value.id == "os"
            for n in ast.walk(fn)
        )

    fns = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    # AST, not substring: the Windows helper's docstring legitimately MENTIONS
    # os.kill to explain why it must not be used. What matters is that it never
    # CALLS it — CPython maps os.kill on Windows to OpenProcess +
    # TerminateProcess for any signal but CTRL_C/BREAK, so the old "liveness
    # probe" terminated the desktop app two seconds after launch.
    assert not _calls_os_kill(fns["_watch_windows"])
    win_src = ast.get_source_segment(src, fns["_watch_windows"]) or ""
    assert "WaitForSingleObject" in win_src and "SYNCHRONIZE" in win_src
    # The POSIX probe still uses it, where signal 0 really is a liveness check.
    assert _calls_os_kill(fns["_watch_posix"])


def test_watchdog_starts_no_thread_for_a_malformed_parent_pid(monkeypatch):
    """A garbage env value must mean 'no watchdog', not a wrong one."""
    import threading

    from app import packaged_main

    monkeypatch.setenv("STORAGE_AGENT_PARENT_PID", "not-a-pid")
    before = threading.active_count()
    packaged_main._start_parent_watchdog()
    assert threading.active_count() == before


# --- W2: /health identity nonce --------------------------------------------

def test_health_echoes_launch_nonce(monkeypatch):
    monkeypatch.setenv("STORAGE_AGENT_LAUNCH_NONCE", "abc123nonce")
    from app.routers import health as health_mod

    importlib.reload(health_mod)
    try:
        out = health_mod.health()
        assert out["launch_nonce"] == "abc123nonce"
        assert out["status"] == "ok"
    finally:
        monkeypatch.delenv("STORAGE_AGENT_LAUNCH_NONCE", raising=False)
        importlib.reload(health_mod)


def test_health_omits_nonce_when_unset(monkeypatch):
    monkeypatch.delenv("STORAGE_AGENT_LAUNCH_NONCE", raising=False)
    from app.routers import health as health_mod

    importlib.reload(health_mod)
    out = health_mod.health()
    assert "launch_nonce" not in out
    # The nonce is an identity marker, never a credential: it must not be
    # confused with the auth token.
    assert "token" not in " ".join(out.keys())


# --- W3: packaged webview origins -------------------------------------------

def test_cors_allows_tauri_windows_origin():
    from app.main import _ALLOWED_ORIGINS

    # Tauri v2 serves the packaged app from tauri://localhost on macOS but
    # http://tauri.localhost on Windows/Android. Every call carries the
    # X-Sidecar-Token header (non-simple → preflighted), so a missing origin
    # meant the packaged Windows app could not reach its own sidecar.
    assert "http://tauri.localhost" in _ALLOWED_ORIGINS
    assert "tauri://localhost" in _ALLOWED_ORIGINS


# --- S1: survey_account advertises the range its schema accepts -------------

def test_survey_account_max_buckets_matches_schema():
    from app.models.schemas import RunCreate

    # The tool clamped to 2000 while RunCreate caps at 500, so a model that
    # took the docstring at its word got a ValidationError instead of a survey.
    field = RunCreate.model_fields["max_buckets"]
    ceiling = next(m.le for m in field.metadata if hasattr(m, "le"))
    assert ceiling == 500

    from app.agent_runtime import session_action_tools

    src = inspect.getsource(session_action_tools)
    assert "min(int(max_buckets), 500)" in src
    assert "1-2000" not in src
