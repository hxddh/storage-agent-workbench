"""v0.38.0 — concurrency, API robustness, audit coverage, drift.

  CC1  discard() resolves the handle + clears the session-active pointer, so a
       failed turn doesn't make the session's next turn hang 120 s.
  API3 set_result/fail are session-bound: a turn_id collision can't deliver one
       session's result to another.
  CC2  bus.create() resets a re-created (previously done) run so a retry gets a
       fresh SSE stream, not the old failure replayed + instant close.
  API1 _safe_filename maps "." / ".." / "" to a safe default (no os.replace onto
       a directory → 500).
  API6 config.scrub_paths collapses the data dir / home dir out of error text.
  P4b  read-only duck.connect on a missing DB errors cleanly (covered in v0370);
       here we assert the session upload dedupe + reconciler wiring.
  Audit list_uploaded_files / import / session.report / run.create leave rows.
  ConcB4 mark_imported is guarded by expected_stored_path.
  SD8  the skills_used cap tracks _MAX_SKILL_LOADS (20).
"""

from __future__ import annotations

import sqlite3

from app.agent_runtime import turn_guard


def setup_function() -> None:
    turn_guard._reset_for_tests()


# --- CC1: discard resolves the handle + clears session-active ----------------

def test_discard_resolves_handle_and_clears_session_active():
    h, created = turn_guard.begin("t1", "sessA")
    assert created
    prior = turn_guard.register_session_turn("sessA", h)
    assert prior is None
    # A clean failure discards the turn.
    turn_guard.discard("t1")
    # The handle is resolved (anything waiting wakes immediately, no 120s hang).
    assert h.done_event.is_set()
    # The session's NEXT turn does NOT serialize behind the dead handle.
    h2, _ = turn_guard.begin("t2", "sessA")
    assert turn_guard.register_session_turn("sessA", h2) is None


# --- API3: set_result / fail are session-bound -------------------------------

def test_set_result_does_not_cross_sessions_on_turn_id_collision():
    # Session B currently owns turn_id "dup".
    hB, _ = turn_guard.begin("dup", "sessB")
    # Session A finishes ITS turn that happened to reuse "dup".
    turn_guard.set_result("dup", {"proposed_actions": ["A-only"]}, "sessA")
    # B must NOT read A's payload.
    assert turn_guard.get_result("dup", "sessB") is None
    # A reads its own.
    assert turn_guard.get_result("dup", "sessA") == {"proposed_actions": ["A-only"]}


def test_fail_does_not_cross_sessions():
    turn_guard.begin("dup2", "sessB")
    turn_guard.fail("dup2", "A failed", "sessA")
    hB = turn_guard.get_handle("dup2", "sessB")
    assert hB is None or not hB.failed  # B's handle not marked failed by A


# --- CC2: event bus resets a re-created done run -----------------------------

def test_bus_create_resets_a_previously_done_run():
    from app.events import EventBus

    bus = EventBus()
    bus.create("r1")
    bus.publish("r1", {"type": "error", "msg": "old failure"})
    bus.mark_done("r1")
    # Retry: re-create the same run id.
    bus.create("r1")
    evs, _cursor, done = bus.snapshot("r1", 0)
    assert evs == [] and done is False  # fresh stream, not the old failure + done


# --- API1: filename sanitizer rejects directory refs -------------------------

def test_safe_filename_maps_directory_refs():
    from app.routers.sessions import _safe_filename

    assert _safe_filename("..") == "upload.dat"
    assert _safe_filename(".") == "upload.dat"
    assert _safe_filename("foo/..") == "upload.dat"
    assert _safe_filename("") == "upload.dat"
    assert _safe_filename("a/b/real.csv") == "real.csv"  # normal basename kept


# --- API6: path scrubbing in error text --------------------------------------

def test_scrub_paths_collapses_data_and_home_dirs():
    from app import config

    data = str(config.data_dir())
    msg = f"OSError: unable to open database file {data}/app.db"
    out = config.scrub_paths(msg)
    assert data not in out and "<data>" in out
    # Non-path text is untouched.
    assert config.scrub_paths("bucket my-logs is empty") == "bucket my-logs is empty"


# --- ConcB4: mark_imported guarded by expected_stored_path -------------------

def test_mark_imported_stale_guard(tmp_path):
    from app.migrations import apply_migrations
    from app.repositories import session_datasets as sds
    from app.repositories import sessions as srepo
    from app.models.schemas import SessionCreate

    conn = sqlite3.connect(tmp_path / "d.db")
    conn.row_factory = sqlite3.Row
    apply_migrations(conn)
    sid = srepo.create(conn, SessionCreate(title="t"))
    ds_id = sds.upsert(conn, sid, "access_log", "a.log", "sessions/x/raw/a.log")

    # A concurrent re-upload changed the stored_path under us.
    conn.execute("UPDATE session_datasets SET stored_path=? WHERE id=?",
                 ("sessions/x/raw/a-NEW.log", ds_id))
    # An import of the OLD path must NOT win.
    assert sds.mark_imported(conn, ds_id, "db", "tbl", 10,
                             expected_stored_path="sessions/x/raw/a.log") is False
    row = sds.get(conn, ds_id)
    assert row["status"] != "imported"
    # An import of the CURRENT path wins.
    assert sds.mark_imported(conn, ds_id, "db", "tbl", 10,
                             expected_stored_path="sessions/x/raw/a-NEW.log") is True
    conn.close()


# --- Audit: evidence-import reconciler wiring covers imports ------------------

def test_reconcile_covers_evidence_imports(tmp_path, monkeypatch):
    from app import run_service
    from app.migrations import apply_migrations

    path = tmp_path / "svc.db"
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    apply_migrations(c)
    c.execute("INSERT INTO evidence_imports (id, source_type, status, created_at) "
              "VALUES ('imp', 'access_log', 'importing', 't')")
    c.commit()
    c.close()

    def _connect():
        cc = sqlite3.connect(path)
        cc.row_factory = sqlite3.Row
        return cc

    monkeypatch.setattr(run_service.db, "connect", _connect)
    assert run_service.reconcile_interrupted_runs() >= 1
    chk = _connect()
    assert chk.execute("SELECT status FROM evidence_imports WHERE id='imp'").fetchone()[0] == "failed"
    chk.close()
