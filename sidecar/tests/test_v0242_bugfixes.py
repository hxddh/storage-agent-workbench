"""Regression tests for the v0.24.2 adversarial-hunt fixes.

Each test pins a bug that shipped because the real path was under-exercised:
- turn_guard.fail() must wake an attached waiter (AS-1)
- a still-running handle must not be evicted by the _MAX cap (AS-6)
- set_result binds session_id so an evicted+recreated handle can't cross sessions
- multi-member (concatenated) gzip must fully decompress (RF-1)
- allowed_prefixes must not be bypassed by an empty/None listing prefix (RF-2)
- a 0-byte inventory CSV is an empty result, not a crash (RF-5)
"""
import gzip
import io
import threading
import time

import pytest

from app.agent_runtime import turn_guard
from app.s3.scope import check_scope


# --- AS-1: fail() wakes an attached waiter immediately ----------------------

def test_fail_wakes_attached_waiter():
    turn_guard._reset_for_tests()
    tid, sid = "t-fail", "s1"
    owner, created = turn_guard.begin(tid, sid)
    assert created is True

    waiter, w_created = turn_guard.begin(tid, sid)
    assert w_created is False and waiter is owner  # attaches to the same handle

    woke = {}

    def wait():
        t0 = time.monotonic()
        got = waiter.done_event.wait(10.0)
        woke["elapsed"] = time.monotonic() - t0
        woke["done"] = got

    th = threading.Thread(target=wait)
    th.start()
    time.sleep(0.1)
    turn_guard.fail(tid, "boom", sid)  # worker error path
    th.join(5.0)

    assert woke.get("done") is True
    assert woke["elapsed"] < 1.0  # woke promptly, NOT after a 150s timeout
    assert waiter.failed is True and waiter.error == "boom"
    assert waiter.payload is None


# --- AS-6: running handles survive the LRU cap ------------------------------

def test_running_handle_not_evicted_by_cap():
    turn_guard._reset_for_tests()
    running, _ = turn_guard.begin("keep-running", "s1")  # never completed
    # Flood the registry with more than _MAX completed turns.
    for i in range(turn_guard._MAX + 50):
        turn_guard.begin(f"done-{i}", "s1")
        turn_guard.set_result(f"done-{i}", {"proposed_actions": []}, "s1")
    # The running handle must still be registered (else a fallback re-runs it).
    again, created = turn_guard.begin("keep-running", "s1")
    assert created is False and again is running


def test_set_result_is_session_bound_after_recreate():
    turn_guard._reset_for_tests()
    # A result recorded for one session's turn must never read from another's.
    turn_guard.set_result("shared-tid", {"proposed_actions": ["a"]}, "sessionA")
    assert turn_guard.get_result("shared-tid", "sessionA") is not None
    assert turn_guard.get_result("shared-tid", "sessionB") is None


# --- RF-1: multi-member gzip fully decompresses -----------------------------

def test_multi_member_gzip_fully_decompressed(tmp_path):
    from app.evidence import managed_import

    # Concatenate two independent gzip members (what `cat a.gz b.gz` produces).
    blob = gzip.compress(b"GET /a 200\n") + gzip.compress(b"GET /b 404\n")
    src = tmp_path / "logs.gz"
    src.write_bytes(blob)
    out = io.BytesIO()
    with out:
        managed_import._append_maybe_gunzip(src, out)
        result = out.getvalue()
    assert result == b"GET /a 200\nGET /b 404\n"  # NEITHER member dropped


# --- RF-2: allowed_prefixes not bypassed by an empty listing prefix ---------

def test_scope_denies_unprefixed_listing_when_prefixes_set():
    # A listing with no/empty prefix would enumerate the whole bucket root.
    assert check_scope(None, ["logs/"], "b", prefix="", listing=True) is not None
    assert check_scope(None, ["logs/"], "b", prefix=None, listing=True) is not None
    # An in-scope prefix is still allowed.
    assert check_scope(None, ["logs/"], "b", prefix="logs/2024/", listing=True) is None
    # A bucket-level op (head_bucket / config read) is not a listing → allowed.
    assert check_scope(None, ["logs/"], "b", prefix=None, listing=False) is None


# --- RF-5: empty inventory CSV is graceful ----------------------------------

def test_empty_inventory_csv_is_zero_not_crash(tmp_path):
    from app.analysis import inventory

    raw = tmp_path / "empty.csv"
    raw.write_bytes(b"")  # 0 bytes
    duckdb_path = tmp_path / "inv.duckdb"
    out = inventory.import_inventory_file(raw, duckdb_path)
    assert out["row_count"] == 0
