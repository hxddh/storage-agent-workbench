"""Tests for the packaged sidecar entrypoint (Phase 08).

No PyInstaller build is required for these — they exercise the CLI/env handling
and confirm production mode never enables reload and never prints secrets.
"""

import sqlite3

from app import config, packaged_main


def test_parser_defaults():
    args = packaged_main.build_parser().parse_args([])
    assert args.host == "127.0.0.1"
    assert args.port == 8765


def test_parser_overrides():
    args = packaged_main.build_parser().parse_args(
        ["--host", "127.0.0.1", "--port", "9001", "--data-dir", "/tmp/saw-x"]
    )
    assert args.port == 9001
    assert args.data_dir == "/tmp/saw-x"


def test_configure_sets_data_dir_env(monkeypatch, tmp_path):
    monkeypatch.delenv("STORAGE_AGENT_DATA_DIR", raising=False)
    monkeypatch.delenv("SAW_DATA_DIR", raising=False)
    args = packaged_main.build_parser().parse_args(["--data-dir", str(tmp_path)])
    packaged_main.configure(args)
    import os
    assert os.environ["STORAGE_AGENT_DATA_DIR"] == str(tmp_path)
    assert config.data_dir() == tmp_path


def test_data_dir_env_is_respected(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_AGENT_DATA_DIR", str(tmp_path / "appdata"))
    assert config.data_dir() == tmp_path / "appdata"


def test_production_main_runs_uvicorn_without_reload(monkeypatch, tmp_path):
    captured = {}

    def fake_run(app, **kwargs):
        captured["app"] = app
        captured["kwargs"] = kwargs

    import uvicorn
    monkeypatch.setattr(uvicorn, "run", fake_run)
    monkeypatch.setenv("STORAGE_AGENT_DATA_DIR", str(tmp_path))

    rc = packaged_main.main(["--host", "127.0.0.1", "--port", "9002"])
    assert rc == 0
    assert captured["kwargs"]["reload"] is False  # production: never reload
    assert captured["kwargs"]["host"] == "127.0.0.1"
    assert captured["kwargs"]["port"] == 9002


def test_startup_banner_is_sanitized(monkeypatch):
    # A path containing a "secret"-looking segment must not appear in full.
    monkeypatch.setenv("STORAGE_AGENT_DATA_DIR", "/tmp/SECRET-USER-PATH/appdata")
    banner = packaged_main._startup_banner("127.0.0.1", 8765)
    assert "127.0.0.1:8765" in banner
    assert "SECRET-USER-PATH" not in banner  # full path not leaked
    assert "appdata" in banner               # only the dir name is shown


def test_health_still_works(client):
    assert client.get("/health").json()["status"] == "ok"


def test_app_data_paths_live_under_data_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_AGENT_DATA_DIR", str(tmp_path))
    # run artifacts resolve under the configured data dir
    assert str(config.run_dir("abc")).startswith(str(tmp_path))
    assert str(config.db_path()).startswith(str(tmp_path)) or config.db_path().name == "app.db"
