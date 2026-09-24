"""Drive the deterministic run layer directly — the way the Agent does.

There is no HTTP route that creates or starts a run (the durable Agent Task
runtime is the one submit path). Tests that exercise an engine end-to-end
create the run row, attach any dataset, and execute it synchronously through
``run_service.run_sync`` here, then read the result over the read-only
``/runs/{id}`` / ``/reports/{id}`` GETs as before.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from app import audit, config, db, run_service
from app.models.schemas import RunCreate
from app.repositories import datasets as datasets_repo
from app.repositories import runs as runs_repo
from app.repositories import sessions as sessions_repo

_DEFAULT_PROMPT = {"account_discovery": "Discover account-level buckets and evidence sources."}


def _conn() -> sqlite3.Connection:
    return db.connect()


def create_run(run_type: str, *, provider_id: str | None = None, bucket: str | None = None,
               user_prompt: str | None = None, title: str | None = None,
               session_id: str | None = None, **options) -> str:
    """Create a ``pending`` run row (what the retired ``POST /runs`` did)."""
    body = RunCreate(run_type=run_type, provider_id=provider_id, bucket=bucket,
                     user_prompt=user_prompt or _DEFAULT_PROMPT.get(run_type, "x"),
                     title=title, session_id=session_id, **options)
    conn = _conn()
    try:
        run_id = runs_repo.create(conn, body, status="pending")
        if session_id and sessions_repo.get_row(conn, session_id) is not None:
            sessions_repo.link_run(conn, session_id, run_id,
                                   sessions_repo.RUN_ROLE.get(run_type))
        audit.record(conn, "run.create", {"run_id": run_id, "run_type": run_type},
                     run_id=run_id, session_id=session_id)
        conn.commit()
        return run_id
    finally:
        conn.close()


def attach_dataset(run_id: str, dataset_type: str, filename: str, content: bytes | str,
                   name: str | None = None) -> str:
    """Copy a dataset into the run's raw dir and record it."""
    data = content.encode("utf-8") if isinstance(content, str) else content
    raw_dir = config.run_dir(run_id) / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    dest = raw_dir / Path(filename).name
    dest.write_bytes(data)
    conn = _conn()
    try:
        dataset_id = datasets_repo.create(conn, run_id, dataset_type, name, dest.name,
                                          config.rel_path(dest))
        conn.commit()
        return dataset_id
    finally:
        conn.close()


def execute(run_id: str, content: str = "go") -> None:
    """Record the user message and run the engine to completion synchronously."""
    conn = _conn()
    try:
        conn.execute("UPDATE runs SET status = 'running' WHERE id = ?", (run_id,))
        runs_repo.add_message(conn, run_id, role="user", content=content)
        conn.commit()
    finally:
        conn.close()
    run_service.run_sync(run_id)


def run(run_type: str, *, dataset: tuple[str, str, bytes | str] | None = None,
        content: str = "go", **kwargs) -> str:
    """Create + (optionally) attach ``(dataset_type, filename, content)`` + execute."""
    run_id = create_run(run_type, **kwargs)
    if dataset is not None:
        attach_dataset(run_id, *dataset)
    execute(run_id, content)
    return run_id
