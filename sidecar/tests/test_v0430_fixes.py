"""v0.43.0 — vault write-safety and bounded survey concurrency.

  V1  a write based on a cache the vault file has moved past no longer discards
      the other writer's secret (the two-instance data-loss path).
  V2  reads still come from the cache — the mtime check is a WRITE guard, not a
      re-decrypt on every get.
  C1  the per-bucket probes really run concurrently.
  C2  results stay keyed to their bucket, in the original order, with the raw
      reads stripped and the true elapsed time captured.
  C3  a probe that raises is captured per bucket and re-raised on the run thread,
      so run_tool records the same error row it always did.
  C4  run_tool honours an explicit duration_ms (so a recorded call whose work
      happened in the pool doesn't claim ~0 ms).
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time

from app.runs import account_discovery_run as adr
from app.s3 import account_tools


# --- V1/V2: vault write-safety ----------------------------------------------

def _save_in_separate_process(data_dir: str, scope: str, name: str, value: str) -> None:
    """Store a secret from ANOTHER process, i.e. with its own module cache."""
    code = textwrap.dedent(
        """
        import os, sys
        os.environ['STORAGE_AGENT_DATA_DIR'] = %r
        sys.path.insert(0, %r)
        from app.security import keyring_store as ks
        ks.save_secret(%r, %r, %r)
        """
    ) % (data_dir, os.getcwd(), scope, name, value)
    subprocess.run([sys.executable, "-c", code], check=True)


def test_stale_cache_write_does_not_destroy_another_writers_secret(tmp_path, monkeypatch):
    monkeypatch.setenv("STORAGE_AGENT_DATA_DIR", str(tmp_path))
    from app.security import keyring_store as ks

    ks._reset_for_tests()
    ks.save_secret("cloud", "provA", "A")

    # This process now caches the blob as it stands (provA only).
    ks._reset_for_tests()
    assert ks.get_secret("cloud", "provA") == "A"

    # A second instance stores its own key — the file moves past our cache.
    _save_in_separate_process(str(tmp_path), "cloud", "provB", "B")

    # We now write. A whole-file rewrite from the stale cache would drop provB.
    ks.save_secret("model", "openai", "B2")

    ks._reset_for_tests()
    assert ks.get_secret("cloud", "provA") == "A"
    assert ks.get_secret("cloud", "provB") == "B"   # the regression this guards
    assert ks.get_secret("model", "openai") == "B2"


def test_reads_still_come_from_cache(tmp_path, monkeypatch):
    """The mtime check guards WRITES; reads must not re-decrypt every call."""
    monkeypatch.setenv("STORAGE_AGENT_DATA_DIR", str(tmp_path))
    from app.security import keyring_store as ks

    ks._reset_for_tests()
    ks.save_secret("cloud", "k", "v")

    # Count actual DISK reads of the vault, which is what the guard could have
    # made expensive — `_ensure_loaded` itself is still called per read and
    # early-returns the warm cache.
    reads = {"n": 0}
    real_read = ks.Path.read_bytes

    def counting_read(self, *a, **kw):
        if self.name.endswith(".enc"):
            reads["n"] += 1
        return real_read(self, *a, **kw)

    monkeypatch.setattr(ks.Path, "read_bytes", counting_read)
    for _ in range(5):
        assert ks.get_secret("cloud", "k") == "v"
    assert reads["n"] == 0, "reads must be served from the cache, not re-decrypted"

    # A WRITE, by contrast, re-checks the file — and re-reads it when it changed.
    _save_in_separate_process(str(tmp_path), "cloud", "other", "x")
    ks.save_secret("cloud", "k2", "v2")
    assert reads["n"] >= 1, "a write must re-read a vault that changed underneath"


# --- C1..C3: bounded survey concurrency -------------------------------------

def _stub_probes(monkeypatch, latency: float = 0.0, boom: str | None = None):
    def snap(conn, pid, bucket):
        if latency:
            time.sleep(latency)
        if boom is not None and bucket == boom:
            raise RuntimeError("probe exploded")
        return {"bucket": bucket, "head_bucket_status": "available", "_raw_reads": {"x": 1}}

    def ev(conn, pid, bucket, pre_reads=None):
        if latency:
            time.sleep(latency)
        return {"sources": [], "saw_pre_reads": pre_reads is not None}

    monkeypatch.setattr(account_tools, "get_bucket_config_snapshot", snap)
    monkeypatch.setattr(account_tools, "discover_evidence_sources", ev)


def test_probes_run_concurrently(client, monkeypatch):
    latency = 0.12
    names = [f"b{i:02d}" for i in range(12)]
    _stub_probes(monkeypatch, latency=latency)

    started = time.monotonic()
    adr._probe_buckets("p1", names)
    elapsed = time.monotonic() - started

    serial = len(names) * 2 * latency
    # Four workers: comfortably under half the serial cost even on a loaded box.
    assert elapsed < serial * 0.6, f"no real parallelism ({elapsed:.2f}s vs {serial:.2f}s serial)"


def test_probe_results_stay_keyed_ordered_and_clean(client, monkeypatch):
    names = ["alpha", "beta", "gamma"]
    _stub_probes(monkeypatch, latency=0.01)

    probes = adr._probe_buckets("p1", names)

    assert list(probes.keys()) == names               # order preserved
    for n in names:
        assert probes[n]["snapshot"]["bucket"] == n   # results never crossed
        # Raw logging/inventory reads are reused in-memory, never recorded.
        assert "_raw_reads" not in probes[n]["snapshot"]
        assert probes[n]["evidence"]["saw_pre_reads"] is True
        assert probes[n]["snapshot_ms"] >= 8          # real elapsed, not ~0


def test_failed_probe_is_isolated_and_replayed(client, monkeypatch):
    _stub_probes(monkeypatch, boom="bad")
    probes = adr._probe_buckets("p1", ["good", "bad"])

    # One bucket's failure never breaks the pool or its neighbour.
    assert probes["good"]["snapshot"]["bucket"] == "good"
    assert "snapshot_exc" in probes["bad"] and "snapshot" not in probes["bad"]

    # …and it re-raises on the run thread, so run_tool records the usual error.
    assert adr._replay(probes["good"], "snapshot")["bucket"] == "good"
    try:
        adr._replay(probes["bad"], "snapshot")
    except RuntimeError as exc:
        assert "probe exploded" in str(exc)
    else:
        raise AssertionError("expected the captured failure to be re-raised")


# --- C4: honest audit durations ---------------------------------------------

def test_run_tool_honours_explicit_duration(client):
    import sqlite3

    from app import config
    from app.tool_runner import run_tool

    conn = sqlite3.connect(str(config.db_path()))
    conn.row_factory = sqlite3.Row
    try:
        run_tool(conn, "get_bucket_config_snapshot", {"bucket": "b"},
                 lambda: {"success": True}, duration_ms=4321)
        row = conn.execute(
            "SELECT duration_ms FROM tool_calls ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
        # Without the override this row would claim ~0 ms for work that really
        # took seconds in the probe pool.
        assert row["duration_ms"] == 4321

        run_tool(conn, "get_bucket_config_snapshot", {"bucket": "b"},
                 lambda: {"success": True})
        row2 = conn.execute(
            "SELECT duration_ms FROM tool_calls ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
        assert row2["duration_ms"] < 1000  # measured locally, as before
    finally:
        conn.close()
