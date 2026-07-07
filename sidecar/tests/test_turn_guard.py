"""Per-turn idempotency guard — dedups a streaming turn and its blocking fallback.

Covers the verified audit bugs: a duplicate inline read-only run (the stream
errored after starting a run, then the fallback re-ran it) and a duplicate whole
turn (the stream completed server-side but the client missed `done`).
"""

from app.agent_runtime import session_action_tools, turn_guard
from app.models.schemas import RunCreate


def test_result_roundtrip():
    turn_guard._reset_for_tests()
    assert turn_guard.get_result("t1") is None
    assert turn_guard.get_result(None) is None  # no turn id → never dedups
    turn_guard.set_result("t1", {"proposed_actions": [1]})
    assert turn_guard.get_result("t1") == {"proposed_actions": [1]}


def test_begin_registers_running_turn_and_attach_semantics():
    turn_guard._reset_for_tests()
    handle, created = turn_guard.begin("t1", "sessA")
    assert created is True and handle is not None
    assert not handle.done  # running, no payload yet
    # A second begin for the SAME session attaches to the SAME handle.
    h2, created2 = turn_guard.begin("t1", "sessA")
    assert created2 is False and h2 is handle
    # Completing it wakes waiters and exposes the payload (session-bound).
    turn_guard.set_result("t1", {"proposed_actions": ["x"]})
    assert handle.done_event.is_set()
    assert turn_guard.get_result("t1", "sessA") == {"proposed_actions": ["x"]}


def test_get_result_is_session_bound():
    """Regression: a turn_id collision across two sessions must NOT return one
    session's result for the other (the old cross-session cache bug)."""
    turn_guard._reset_for_tests()
    turn_guard.begin("dup", "sessA")
    turn_guard.set_result("dup", {"proposed_actions": ["A"]})
    assert turn_guard.get_result("dup", "sessA") == {"proposed_actions": ["A"]}
    assert turn_guard.get_result("dup", "sessB") is None  # different session → miss


def test_cancel_event_and_discard():
    turn_guard._reset_for_tests()
    handle, _ = turn_guard.begin("t2", "sessA")
    assert not handle.cancel_event.is_set()
    handle.cancel_event.set()
    assert turn_guard.get_handle("t2", "sessA").cancel_event.is_set()
    # discard drops a failed attempt so a clean retry can register anew.
    turn_guard.discard("t2")
    assert turn_guard.get_handle("t2", "sessA") is None


def test_run_roundtrip():
    turn_guard._reset_for_tests()
    assert turn_guard.get_run("t1", "k") is None
    turn_guard.set_run("t1", "k", "run-123")
    assert turn_guard.get_run("t1", "k") == "run-123"


def test_execute_run_reuses_existing_run_for_same_turn(monkeypatch):
    """The blocking fallback must reuse a run the failed stream already created,
    not create a second one."""
    turn_guard._reset_for_tests()
    turn_guard.set_run("turnA", "diagnostic:prov:bkt", "existing-run")

    created: list[int] = []
    monkeypatch.setattr(session_action_tools.runs_repo, "create",
                        lambda *a, **k: (created.append(1), "new-run")[1])

    body = RunCreate(run_type="diagnostic", provider_id="prov", bucket="bkt")
    # conn is never touched on the reuse path, so None is fine.
    run_id = session_action_tools._execute_run(None, body, "turnA", "diagnostic:prov:bkt")

    assert run_id == "existing-run"
    assert created == []  # no duplicate run created
