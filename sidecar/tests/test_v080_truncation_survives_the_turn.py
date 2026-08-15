"""v0.80.0 — the caveat that only the first question got.

A dataset larger than the ingest cap is analyzed over its first
``MAX_INGEST_ROWS`` rows (2,000,000). ``analyze_uploaded_file`` said so — but
only on the call that happened to perform the import. The flag lived on that
call's return value and nowhere else: ``_ensure_imported`` returns ``None`` for
the import metadata once the dataset row says ``imported``, and the
``session_datasets`` row had no column to remember it.

So the second question about the same file — and every one after — re-read the
same truncated table and got the numbers back with no caveat at all, including a
``derive_findings`` verdict like "No capacity concerns detected". Multi-turn is
how this product is used, so the silent case was the common one, and the failure
is the expensive direction: the agent tells the user their storage looks fine
having seen a slice of it.

Measured against the unfixed code with the cap lowered to 5 rows:

    analyze turn 1: truncated=True  rows_analyzed=5
    analyze turn 2: truncated=None  rows_analyzed=None      <-- same file
    analyze turn 3: truncated=None  rows_analyzed=None
    aggregate:      source_truncated=None                   <-- never, ever

``aggregate_uploaded_file`` was worse: it discarded the import metadata
entirely, so it never reported truncation even on the importing call.

The fix records truncation on the dataset row, so it is a property of the
dataset rather than of one lucky call. Note that `aggregate`'s payload already
used `truncated` for "more GROUPS exist beyond the limit"; the file-level fact
is `source_truncated`, deliberately not folded into the same word.

This file is part of a sweep for one recurring defect class — the product
stating a verdict it did not establish. Prior instances: "no publicly exposed
buckets" when the check never ran (v0.70.0), an object reported cleanly
deletable when it could not be inspected (v0.74.0), a capability gap reported as
a hard failure (v0.74.0).

Which tests here detect the bug, stated honestly, because it is not uniform.
Run against the unfixed code:

- three fail on a BEHAVIOURAL assertion, and are the real detectors —
  `..._says_so_not_just_the_first` ("turn 2 dropped the caveat: None"),
  `test_aggregate_reports_a_partial_file_too`, and
  `test_the_group_limit_and_the_partial_file_are_not_the_same_word`;
- `test_never_recorded_is_kept_distinct_from_not_truncated` fails with
  `no such column: truncated`. That is the schema being absent, not behaviour
  being wrong, so it is a contract guard rather than a detector;
- the remaining two pass either way by design. They pin what must NOT change:
  a file inside the cap is never caveated, and a re-upload does not inherit the
  previous file's flag.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3

import pytest

from app import config, db, migrations
from app.agent_runtime import session_analysis_tools
from app.analysis import inventory
from app.repositories import session_datasets as sds

_CAP = 5
_ROWS = 20


class _Ctx:
    tool_name = "analyze_uploaded_file"
    run_config = None
    context = None
    usage = None


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """A session with one inventory upload four times the ingest cap."""
    monkeypatch.setattr(config, "data_dir", lambda: tmp_path)
    # Lower the ceiling instead of building a 2,000,000-row file: the code path
    # is the same one, and the test stays in milliseconds.
    monkeypatch.setattr(inventory, "MAX_INGEST_ROWS", _CAP)

    conn = db.serialized(sqlite3.connect(":memory:", check_same_thread=False))
    conn.row_factory = sqlite3.Row
    migrations.apply_migrations(conn)
    conn.execute("INSERT INTO sessions (id, title, created_at, updated_at) "
                 "VALUES ('s1', 't', '2026-01-01', '2026-01-01')")
    conn.commit()

    raw = tmp_path / "inv.csv"
    raw.write_text("bucket,key,size,storage_class,last_modified\n" + "".join(
        f"acme,logs/p{i}.parquet,{1024 * (i + 1)},STANDARD,2026-06-01T00:00:00Z\n"
        for i in range(_ROWS)))
    dataset_id = sds.upsert(conn, "s1", "inventory", "inv.csv", config.rel_path(raw))
    conn.commit()

    from agents import function_tool
    tools = session_analysis_tools.build(conn, function_tool, "s1", [])
    return conn, dataset_id, {t.name: t for t in tools}


def _call(tool, **args) -> dict:
    return json.loads(asyncio.run(tool.on_invoke_tool(_Ctx(), json.dumps(args))))


# --- the detectors -----------------------------------------------------------


def test_every_analysis_of_a_truncated_file_says_so_not_just_the_first(env):
    """The regression this release exists for.

    Verified to FAIL before the fix: turn 1 reported `truncated`, turns 2 and 3
    reported nothing, on the same dataset and the same table.
    """
    _conn, dataset_id, tools = env
    seen = [_call(tools["analyze_uploaded_file"], dataset_id=dataset_id)
            for _ in range(3)]

    for turn, out in enumerate(seen, 1):
        assert out.get("truncated") is True, f"turn {turn} dropped the caveat: {out.get('note')!r}"
        assert out.get("rows_analyzed") == _CAP, f"turn {turn}: {out!r}"
        assert "LOWER BOUND" in (out.get("note") or ""), f"turn {turn} note: {out.get('note')!r}"

    # And the numbers really are the partial ones, so the caveat is not cosmetic.
    assert seen[0]["row_count"] == _CAP < _ROWS


def test_aggregate_reports_a_partial_file_too(env):
    """`aggregate_uploaded_file` discarded the import metadata outright, so it
    never mentioned truncation — not even on the call that imported."""
    _conn, dataset_id, tools = env
    out = _call(tools["aggregate_uploaded_file"], dataset_id=dataset_id,
                metric="total_size", group_by="storage_class")
    assert out.get("source_truncated") is True, out
    assert out.get("rows_analyzed") == _CAP, out
    assert "LOWER BOUND" in (out.get("note") or ""), out.get("note")


def test_the_group_limit_and_the_partial_file_are_not_the_same_word(env):
    """`truncated` in an aggregate means "more groups exist beyond the limit".
    Folding a partial FILE into that key would quietly change what a caveat the
    model already knows how to read is claiming."""
    _conn, dataset_id, tools = env
    out = _call(tools["aggregate_uploaded_file"], dataset_id=dataset_id,
                metric="total_size", group_by="storage_class")
    # One group ('STANDARD'), so the group list is complete...
    assert out.get("truncated") is False, out
    # ...while the file underneath it is not.
    assert out.get("source_truncated") is True, out


# --- the surrounding contract ------------------------------------------------


def test_a_file_within_the_cap_is_not_caveated(env):
    """The guard must not cry wolf: a file that fits carries no caveat, and the
    absence has to survive re-analysis just as the presence does."""
    conn, _dataset_id, tools = env
    small = config.data_dir() / "small.csv"
    small.write_text("bucket,key,size,storage_class,last_modified\n"
                     "acme,logs/a.parquet,1024,STANDARD,2026-06-01T00:00:00Z\n")
    dataset_id = sds.upsert(conn, "s1", "inventory", "small.csv", config.rel_path(small))
    conn.commit()

    for _ in range(2):
        out = _call(tools["analyze_uploaded_file"], dataset_id=dataset_id)
        assert out.get("truncated") is None, out
        assert "LOWER BOUND" not in (out.get("note") or "")


def test_re_uploading_clears_the_previous_file_s_caveat(env):
    """The flag describes the file that was imported. A re-upload reuses the row
    (same session + filename), so a stale `truncated` would caveat the new
    file on the old one's evidence — or, worse, the other way round."""
    conn, dataset_id, tools = env
    assert _call(tools["analyze_uploaded_file"], dataset_id=dataset_id)["truncated"] is True

    # Same filename, now a file that fits well inside the cap.
    (config.data_dir() / "inv.csv").write_text(
        "bucket,key,size,storage_class,last_modified\n"
        "acme,logs/only.parquet,1024,STANDARD,2026-06-01T00:00:00Z\n")
    again = sds.upsert(conn, "s1", "inventory", "inv.csv",
                       config.rel_path(config.data_dir() / "inv.csv"))
    conn.commit()
    assert again == dataset_id, "the re-upload should reuse the row, or this tests nothing"

    out = _call(tools["analyze_uploaded_file"], dataset_id=dataset_id)
    assert out.get("truncated") is None, f"stale caveat carried over: {out!r}"
    assert out["row_count"] == 1


def test_a_dataset_imported_before_this_release_gets_re_established(env):
    """Review on #167, and the hole was real.

    Rows imported by an older version have `truncated` NULL, and NULL was read as
    "not truncated". Nothing would ever have corrected it: `_ensure_imported`
    reuses the built table while the row says 'imported', so the importer never
    runs again and a large upload from before the upgrade would answer
    uncaveated forever — the docstring's claim that it "self-corrects on the next
    re-import" was describing an event that does not happen.

    Migration 24 sends imported rows back to 'uploaded' so the next analysis
    re-derives the fact. Simulated here by putting a row in exactly the state an
    upgrade leaves behind.
    """
    conn, dataset_id, tools = env
    _call(tools["analyze_uploaded_file"], dataset_id=dataset_id)  # imports, records

    # The pre-upgrade shape: imported, with the columns never filled in, and
    # migration 24 not yet applied to it.
    conn.execute("UPDATE session_datasets SET truncated = NULL, ingest_cap = NULL, "
                 "status = 'imported' WHERE id = ?", (dataset_id,))
    conn.execute("DELETE FROM schema_migrations WHERE version = 24")
    conn.commit()

    migrations.apply_migrations(conn)  # the upgrade

    out = _call(tools["analyze_uploaded_file"], dataset_id=dataset_id)
    assert out.get("truncated") is True, (
        "an upload imported before the upgrade still answers uncaveated: " + repr(out))
    assert out.get("rows_analyzed") == _CAP


def test_an_unrecorded_coverage_is_reported_as_unknown_not_as_whole(env):
    """Belt and braces for the same hole.

    Migration 24 means a NULL on an imported row should not arise. If one does
    anyway, the answer must not be silence — "we never recorded whether this was
    the whole file" is the exact shape of unknown-rendered-as-fine that this
    sweep exists to remove."""
    conn, dataset_id, tools = env
    _call(tools["analyze_uploaded_file"], dataset_id=dataset_id)
    conn.execute("UPDATE session_datasets SET truncated = NULL, ingest_cap = NULL, "
                 "status = 'imported' WHERE id = ?", (dataset_id,))
    conn.commit()

    out = _call(tools["analyze_uploaded_file"], dataset_id=dataset_id)
    assert out.get("truncation_unknown") is True, out
    assert "coverage is unknown" in (out.get("note") or ""), out.get("note")
    assert out.get("truncated") is not True, "unknown must not be reported as truncated"


def test_the_migration_sends_imported_rows_back_for_re_import(env):
    """The mechanism the test above depends on, asserted directly: an existing
    install's imported datasets are reset so the fact gets established once."""
    conn, dataset_id, _tools = env
    conn.execute("UPDATE session_datasets SET status = 'imported' WHERE id = ?", (dataset_id,))
    conn.execute("DELETE FROM schema_migrations WHERE version = 24")
    conn.commit()
    migrations.apply_migrations(conn)
    assert sds.get(conn, dataset_id)["status"] == "uploaded"


@pytest.mark.parametrize(("metric", "expected"), [
    ("total_size", "LOWER BOUND"),        # sum: unread rows can only add
    ("max_size", "LOWER BOUND"),
    ("distinct_prefixes", "LOWER BOUND"),
    ("min_size", "UPPER BOUND"),          # an unread row can only be smaller
    ("avg_size", "neither an upper nor a lower bound"),
])
def test_the_caveat_states_the_bound_the_metric_actually_has(env, metric, expected):
    """Review on #167: "every number is a LOWER BOUND" is false for averages,
    percentiles and minima. A caveat that hands the model a wrong inequality is
    worse than no caveat — it invites reasoning from it."""
    _conn, dataset_id, tools = env
    out = _call(tools["aggregate_uploaded_file"], dataset_id=dataset_id, metric=metric)
    assert expected in (out.get("note") or ""), f"{metric}: {out.get('note')!r}"


def test_never_recorded_is_kept_distinct_from_not_truncated(env):
    """A row imported before these columns existed has NULL, which is unknown —
    not a claim that the file was complete. It must not be stored as 0, or the
    distinction this release is about is lost on the way back in."""
    conn, dataset_id, tools = env
    _call(tools["analyze_uploaded_file"], dataset_id=dataset_id)
    conn.execute("UPDATE session_datasets SET truncated = NULL, ingest_cap = NULL "
                 "WHERE id = ?", (dataset_id,))
    conn.commit()
    assert sds.get(conn, dataset_id)["truncated"] is None
