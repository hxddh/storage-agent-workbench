"""App data dir verification (Phase 09).

Confirms all user data (SQLite, DuckDB, reports, uploads) resolves under the
configured app data dir and never under an application install dir, and that the
env-var resolution order holds.
"""

from pathlib import Path

from app import config


def test_all_artifacts_under_data_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_AGENT_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("SAW_DB_PATH", raising=False)

    data = config.data_dir()
    assert data == tmp_path

    # SQLite DB, per-run dir (raw uploads + analysis.duckdb + report.md live here)
    assert config.db_path() == tmp_path / "app.db"
    run = config.run_dir("run123")
    assert run == tmp_path / "runs" / "run123"
    assert str(run).startswith(str(tmp_path))


def test_storage_agent_data_dir_takes_precedence(monkeypatch, tmp_path):
    canonical = tmp_path / "canonical"
    legacy = tmp_path / "legacy"
    monkeypatch.setenv("STORAGE_AGENT_DATA_DIR", str(canonical))
    monkeypatch.setenv("SAW_DATA_DIR", str(legacy))
    assert config.data_dir() == canonical


def test_legacy_env_still_works(monkeypatch, tmp_path):
    monkeypatch.delenv("STORAGE_AGENT_DATA_DIR", raising=False)
    monkeypatch.setenv("SAW_DATA_DIR", str(tmp_path / "legacy"))
    assert config.data_dir() == tmp_path / "legacy"


def test_data_dir_is_not_inside_app_bundle(monkeypatch, tmp_path):
    # A production-style app-data path must not point inside a .app install dir.
    monkeypatch.setenv("STORAGE_AGENT_DATA_DIR", str(tmp_path / "AppData"))
    data = str(config.data_dir())
    assert ".app/Contents" not in data
    assert "/Applications/" not in data


def test_relative_path_recording(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_AGENT_DATA_DIR", str(tmp_path))
    abs_report = config.run_dir("r1") / "report.md"
    rel = config.rel_path(abs_report)
    # Recorded path is relative to the data dir (no absolute/user path leak).
    assert rel == str(Path("runs") / "r1" / "report.md")
    assert not rel.startswith("/")
