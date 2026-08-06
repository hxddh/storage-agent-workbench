"""v0.59.0 — the write lock never reached the action and analysis tools.

v0.55.0 introduced ``db.WRITE_LOCK`` because parallel tool calls share ONE
connection, and a connection has ONE transaction: thread A's ``commit()``
commits B's half-written work, and B's own ``commit()`` then raises
``cannot commit - no transaction is active``. The agent sees a FAILED call for
work that actually succeeded, and rule 17's "every tool call is recorded"
quietly does not hold.

The lock was applied to ``session_tools`` bookkeeping and the five memory tools.
It was never applied to ``session_action_tools`` or ``session_analysis_tools``,
which held ELEVEN unguarded ``conn.commit()`` calls between them — on
agent-callable tools that run in parallel with the guarded ones, on the same
connection.

An unguarded ``commit()`` is worse than an unguarded INSERT: it commits whatever
transaction is open, including another thread's lock-held work in progress.

Measured against the unfixed code over 120 forced pairs: **12 of 240 calls died
(5.0%)** with exactly ``cannot commit - no transaction is active`` — six times
the 2/240 (0.8%) that motivated the lock in the first place. All 120 memory rows
were nonetheless present, which is the expensive part: the write LANDED and the
agent was told it had not.

All three tests below were verified to FAIL against the unfixed code before the
fix was written.
"""
from __future__ import annotations

import asyncio
import sqlite3
import threading

import pytest

from app import migrations
from app.agent_runtime import session_analysis_tools, session_memory_tools


class _Ctx:
    """Minimal RunContextWrapper stand-in for invoking a real FunctionTool."""

    tool_name = "test"
    run_config = None
    context = None
    usage = None


@pytest.fixture()
def conn():
    # check_same_thread=False mirrors app/db.py, and it matters here: the SDK
    # dispatches a sync tool with asyncio.to_thread, so tool bodies genuinely run
    # off the creating thread — which is what this test reproduces.
    c = sqlite3.connect(":memory:", check_same_thread=False)
    c.row_factory = sqlite3.Row
    migrations.apply_migrations(c)
    c.execute("INSERT INTO sessions (id, title, created_at, updated_at) "
              "VALUES ('s1', 't', '2026-08-06T00:00:00Z', '2026-08-06T00:00:00Z')")
    c.commit()
    return c


def _tool(tools, name):
    return [t for t in tools if t.name == name][0]


def _pair_tools(conn, activity):
    from agents import function_tool
    mem = session_memory_tools.build(conn, function_tool, "s1", activity)
    ana = session_analysis_tools.build(conn, function_tool, "s1", activity)
    return _tool(mem, "note_fact"), _tool(ana, "list_uploaded_files")


def _run_forced_pair(conn, rounds: int) -> tuple[int, list[str]]:
    """Drive a GUARDED write and an UNGUARDED commit into the same instant.

    ``note_fact`` writes agent memory under db.WRITE_LOCK. ``list_uploaded_files``
    writes an audit row and commits. Both are agent tools the model can call in
    one parallel step, and both run on the turn's single shared connection.
    """
    activity: list = []
    note_fact, list_files = _pair_tools(conn, activity)

    # Line the two bodies up so they collide rather than merely running near each
    # other. Both tools call audit.record, so it is the one point both reach.
    #
    # The barrier is BEST-EFFORT, and its short timeout is load-bearing. Before
    # the fix the two bodies could genuinely be inside audit.record at the same
    # instant, so they meet immediately. After the fix they cannot — that is what
    # the fix DOES — so `note_fact` waits at the barrier while holding the lock
    # and `list_uploaded_files` blocks acquiring it, and the barrier can only
    # ever time out. A 10s timeout therefore turned a passing run into a 20-minute
    # hang. 50ms is ample for two threads that are already running to meet, and
    # bounds a fully-serialized run to a few seconds.
    barrier = threading.Barrier(2, timeout=0.05)
    from app import audit as audit_mod
    real_record = audit_mod.record

    def barriered_record(*a, **kw):
        try:
            barrier.wait()
        except threading.BrokenBarrierError:  # pragma: no cover — timing guard
            pass
        return real_record(*a, **kw)

    audit_mod.record = barriered_record
    errors: list[str] = []
    try:
        async def pair(i: int):
            out = await asyncio.gather(
                note_fact.on_invoke_tool(_Ctx(), f'{{"text": "fact number {i}"}}'),
                list_files.on_invoke_tool(_Ctx(), "{}"),
                return_exceptions=True,
            )
            for o in out:
                if isinstance(o, BaseException):
                    errors.append(repr(o))
                elif isinstance(o, str) and "no transaction is active" in o:
                    errors.append(o[:200])

        for i in range(rounds):
            barrier.reset()
            asyncio.run(pair(i))
    finally:
        audit_mod.record = real_record

    done = [a for a in activity if a.get("status") != "started"]
    return len(done), errors


def test_guarded_and_unguarded_writers_never_lose_a_call(conn):
    """The regression this release exists for.

    Verified to FAIL before the fix: `list_uploaded_files` committed without the
    lock, so it committed `note_fact`'s in-flight transaction and the memory tool
    raised on its own commit.
    """
    rounds = 120
    done, errors = _run_forced_pair(conn, rounds)
    assert not errors, f"a tool call died on a commit race: {errors[:3]}"
    assert done == rounds * 2, f"{rounds * 2 - done} of {rounds * 2} calls lost"


def test_the_agent_is_never_told_a_landed_write_failed(conn):
    """The damage is a FALSE FAILURE, not a lost row — which is worse.

    Measured against the unfixed code over 120 forced pairs: 12 of 240 calls died
    (5.0%), while all 120 memory rows were present. The stray commit from the
    unguarded tool COMMITTED the memory tool's work; the memory tool's own commit
    then found no transaction and raised. So the write landed and the agent was
    told it had not.

    That is the expensive failure: an agent that believes `note_fact` failed will
    record the fact again, or tell the user it could not save a finding that is
    sitting in the database.
    """
    rounds = 120
    _, errors = _run_forced_pair(conn, rounds)
    rows = conn.execute(
        "SELECT count(*) FROM session_agent_memory WHERE session_id = 's1'").fetchone()[0]
    # Every reported failure must be a real failure: if the row count matches the
    # number of ATTEMPTS while calls reported errors, those errors were lies.
    assert not (errors and rows == rounds), (
        f"{len(errors)} calls reported failure but all {rows} writes landed — "
        "the agent was told the truth was false")
    assert not errors, f"a tool call died on a commit race: {errors[:3]}"


def test_the_unguarded_commit_sites_are_gone():
    """A structural guard, so the eleven sites cannot silently come back.

    The behavioural tests above are probabilistic — they detect the race, but a
    lucky run could pass. This one is deterministic: it reads the source and
    fails if any `conn.commit()` in the agent-callable tool modules sits outside
    a `with db.WRITE_LOCK:` block.
    """
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "app" / "agent_runtime"
    offenders: list[str] = []
    checked = 0
    for name in ("session_action_tools.py", "session_analysis_tools.py",
                 "session_tools.py", "session_memory_tools.py"):
        path = root / name
        if not path.exists():
            continue
        checked += 1
        depth: int | None = None
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            indent = len(line) - len(line.lstrip())
            if depth is not None and line.strip() and indent <= depth:
                depth = None
            if "with db.WRITE_LOCK" in line:
                depth = indent
            if re.search(r"\bconn\.commit\(\)", line) and depth is None:
                offenders.append(f"{name}:{lineno}")
    # If the modules are ever renamed this guard would silently pass on nothing.
    assert checked == 4, "the tool modules moved — this guard is not looking at them"
    assert offenders == [], (
        "unguarded conn.commit() on the shared turn connection: " + ", ".join(offenders))
