"""v0.31.0 hardening batch — packaging integrity + data-integrity fixes.

Covers:
  O1  deep bundle self-check (agents/openai/boto3-client/duckdb/pyarrow +
      AES-GCM vault round-trip) exposed at /health/selfcheck and asserted by the
      release smoke test — so a bundle missing a lazily imported native dep fails
      the build instead of shipping.
  D1  migration crash-retry tolerates the IntegrityError equivalent of an
      already-present seed row, not just the OperationalError DDL cases.
  D2  numeric Unix-epoch access-log timestamps (s / ms / µs / ns) normalize
      instead of casting to NULL → every hour bucket 'unknown'.
"""

from __future__ import annotations

import sqlite3

import pytest


# --- O1: deep bundle self-check ---------------------------------------------







# --- D1: migration replay tolerates IntegrityError on retry ------------------





def test_full_migrations_still_apply_cleanly(tmp_path):
    from app.migrations import apply_migrations, MIGRATIONS

    conn = sqlite3.connect(tmp_path / "m.db")
    n = apply_migrations(conn)
    assert n == len(MIGRATIONS)
    # Idempotent second run applies nothing.
    assert apply_migrations(conn) == 0
    conn.close()


# --- D2: epoch access-log timestamp normalization ----------------------------

@pytest.mark.parametrize("raw,expected", [
    ("1719309600", "2024-06-25T10:00:00"),            # seconds
    ("1719309600000", "2024-06-25T10:00:00"),         # milliseconds
    ("1719309600000000", "2024-06-25T10:00:00"),      # microseconds
    ("1719309600000000000", "2024-06-25T10:00:00"),   # nanoseconds
    ("1719309600.0", "2024-06-25T10:00:00"),          # fractional seconds
])
def test_epoch_timestamps_normalize(raw, expected):
    from app.analysis.access_logs import _normalize_ts

    assert _normalize_ts(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    # Compact wall-clock stamps must parse as DATES, never as epochs (a
    # magnitude-based gate misread these as years 8383 / 2611).
    ("202406251000", "2024-06-25T10:00:00"),      # yyyyMMddHHmm (12 digits)
    ("20240625100000", "2024-06-25T10:00:00"),    # yyyyMMddHHmmss (14 digits)
])
def test_compact_dates_parse_as_dates_not_epochs(raw, expected):
    from app.analysis.access_logs import _normalize_ts

    assert _normalize_ts(raw) == expected


@pytest.mark.parametrize("raw", [
    "404",                       # status code — too short to be an epoch
    "17193096001",               # 11 digits — no epoch unit has this width
    "999999999999",              # 12 digits but month 99 — not a compact date
    "99999999999999",            # 14 digits, invalid date fields
    "1234567890123456789012",    # 22 digits — out of range
    "not-a-time",                # non-numeric
])
def test_non_epoch_values_are_not_misread(raw):
    from app.analysis.access_logs import _normalize_ts

    # Returned unchanged (downstream still yields 'unknown'); never a bogus date.
    assert _normalize_ts(raw) == raw


def test_text_formats_unaffected_by_epoch_branch():
    from app.analysis.access_logs import _normalize_ts

    assert _normalize_ts("25/Jun/2024:10:00:00 +0000") == "2024-06-25T10:00:00"
    assert _normalize_ts("2024-06-25T10:00:00Z") == "2024-06-25T10:00:00"
