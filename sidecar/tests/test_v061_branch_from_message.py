"""v0.61.0 — branch a new investigation from a point in the thread.

Whole-session `fork` has existed since v0.28.0. What was missing is the
Cursor-style "take it from here": an investigation that went wrong at exchange 30
could only be duplicated whole and then unwound by hand.

Both threads survive on purpose. The original is evidence — a record of what was
actually asked and answered — not a draft to be overwritten, which is why this is
a branch and not the existing in-place edit.
"""
from __future__ import annotations

import sqlite3

import pytest

from app import migrations
from app.repositories import sessions as repo


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    migrations.apply_migrations(c)
    c.execute("INSERT INTO sessions (id,title,goal,provider_id,primary_bucket,status,pinned,"
              "created_at,updated_at) VALUES ('s1','Why is acme-logs big?',NULL,NULL,NULL,"
              "'active',0,'2026-08-06T00:00:00Z','2026-08-06T00:00:00Z')")
    c.commit()
    return c


def _msgs(conn, session_id: str) -> list[str]:
    return [r["content"] for r in conn.execute(
        "SELECT content FROM session_messages WHERE session_id = ? ORDER BY rowid",
        (session_id,))]


def _thread(conn, n: int = 6) -> list[str]:
    """n messages alternating user/assistant, each a second apart."""
    ids = []
    for i in range(n):
        mid = f"m{i}"
        ids.append(mid)
        conn.execute(
            "INSERT INTO session_messages (id,session_id,role,content,created_at) "
            "VALUES (?,?,?,?,?)",
            (mid, "s1", "user" if i % 2 == 0 else "assistant", f"message {i}",
             f"2026-08-06T00:00:{i:02d}Z"))
    conn.commit()
    return ids


def test_branching_keeps_everything_through_the_point_and_nothing_after(conn):
    ids = _thread(conn, 6)
    new_id = repo.fork(conn, "s1", up_to_message_id=ids[3])
    assert new_id is not None
    assert _msgs(conn, new_id) == ["message 0", "message 1", "message 2", "message 3"]


def test_the_original_thread_is_untouched(conn):
    """A branch is not a move. The original is the record of what was asked."""
    ids = _thread(conn, 6)
    repo.fork(conn, "s1", up_to_message_id=ids[3])
    assert len(_msgs(conn, "s1")) == 6


def test_the_branch_point_message_itself_is_included(conn):
    """Inclusive, because the user picks the message they want to depart FROM —
    excluding it would silently drop the question they were looking at."""
    ids = _thread(conn, 4)
    new_id = repo.fork(conn, "s1", up_to_message_id=ids[0])
    assert _msgs(conn, new_id) == ["message 0"]


def test_no_branch_point_still_forks_the_whole_thread(conn):
    """The v0.28.0 behaviour is unchanged when the parameter is absent."""
    _thread(conn, 5)
    new_id = repo.fork(conn, "s1")
    assert len(_msgs(conn, new_id)) == 5


def test_an_unknown_message_is_refused_not_silently_widened(conn):
    """Silently forking the WHOLE thread would hand back a session that looks
    right and is not — the caller asked to branch somewhere specific."""
    _thread(conn, 4)
    assert repo.fork(conn, "s1", up_to_message_id="does-not-exist") is None


def test_a_message_from_another_session_is_refused(conn):
    """The id must belong to the session being branched, or the cut is meaningless."""
    _thread(conn, 4)
    conn.execute("INSERT INTO sessions (id,title,created_at,updated_at) "
                 "VALUES ('s2','other','2026-08-06T00:00:00Z','x')")
    conn.execute("INSERT INTO session_messages (id,session_id,role,content,created_at) "
                 "VALUES ('foreign','s2','user','elsewhere','2026-08-06T00:00:00Z')")
    conn.commit()
    assert repo.fork(conn, "s1", up_to_message_id="foreign") is None
    # And nothing was created before the refusal.
    assert conn.execute("SELECT count(*) FROM sessions").fetchone()[0] == 2


def test_memory_after_the_branch_point_does_not_come_along(conn):
    """Carrying a fact the agent learned AFTER the departure point would put
    knowledge in the branch that its thread never establishes."""
    ids = _thread(conn, 6)
    for i, when in ((0, "2026-08-06T00:00:01Z"), (1, "2026-08-06T00:00:05Z")):
        conn.execute(
            "INSERT INTO session_agent_memory (id,session_id,kind,text,status,created_at) "
            "VALUES (?,?,?,?,?,?)",
            (f"mem{i}", "s1", "fact", f"fact {i}", "active", when))
    conn.commit()
    new_id = repo.fork(conn, "s1", up_to_message_id=ids[3])  # created_at …:03Z
    kept = [r["text"] for r in conn.execute(
        "SELECT text FROM session_agent_memory WHERE session_id = ? ORDER BY rowid", (new_id,))]
    assert kept == ["fact 0"]


def test_a_same_second_row_is_carried_rather_than_dropped(conn):
    """`created_at` is second-resolution, so the tie has to break SOMEWHERE. It
    breaks toward carrying the fact — the recoverable direction — and the
    docstring says so rather than leaving it a surprise."""
    ids = _thread(conn, 4)
    conn.execute(
        "INSERT INTO session_agent_memory (id,session_id,kind,text,status,created_at) "
        "VALUES ('tie','s1','fact','same second','active','2026-08-06T00:00:02Z')")
    conn.commit()
    new_id = repo.fork(conn, "s1", up_to_message_id=ids[2])  # also …:02Z
    kept = [r["text"] for r in conn.execute(
        "SELECT text FROM session_agent_memory WHERE session_id = ?", (new_id,))]
    assert kept == ["same second"]


def test_the_branch_is_titled_differently_from_a_whole_fork(conn):
    """A rail full of '(fork)' entries cannot be told apart. A branch is a
    different act and reads as one."""
    ids = _thread(conn, 4)
    branch = repo.fork(conn, "s1", up_to_message_id=ids[1])
    whole = repo.fork(conn, "s1")
    tb = conn.execute("SELECT title FROM sessions WHERE id = ?", (branch,)).fetchone()["title"]
    tw = conn.execute("SELECT title FROM sessions WHERE id = ?", (whole,)).fetchone()["title"]
    assert tb.endswith("(branch)")
    assert tw.endswith("(fork)")
