"""Local storage-class price table — ordinary config, not a secret.

Ships an example schedule labelled as such. Dollar simulation stays a gap until
the operator confirms they have calibrated the table against their bill.
Credentials never belong here.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from ..repositories import utcnow
from ..security.redaction import redact_text

PRICE_TABLE_ID = "default"

# Illustrative public-cloud list prices (USD / GB-month and per-1k requests).
# These are NOT a quote and MUST be calibrated. Confirmed starts false.
EXAMPLE_NOTE = (
    "Example prices for simulation only. Calibrate against your bill before "
    "treating dollar figures as estimates you can act on. This table is local "
    "configuration, not a credential store."
)

DEFAULT_RATES: dict[str, Any] = {
    "currency": "USD",
    "gb_divisor": 1_000_000_000,
    "storage_gb_month": {
        "STANDARD": 0.023,
        "STANDARD_IA": 0.0125,
        "ONEZONE_IA": 0.01,
        "INTELLIGENT_TIERING": 0.023,
        "GLACIER_IR": 0.004,
        "GLACIER": 0.004,
        "DEEP_ARCHIVE": 0.00099,
        "EXPRESS_ONEZONE": 0.16,
        "REDUCED_REDUNDANCY": 0.024,
    },
    "request_per_1k": {
        "PUT": 0.005,
        "GET": 0.0004,
        "LIST": 0.005,
    },
    "retrieval_gb": {
        "STANDARD_IA": 0.01,
        "GLACIER": 0.03,
        "DEEP_ARCHIVE": 0.02,
    },
}


def example_document() -> dict[str, Any]:
    return {
        "id": PRICE_TABLE_ID,
        "confirmed": False,
        "example": True,
        "note": EXAMPLE_NOTE,
        "rates": DEFAULT_RATES,
        "updated_at": None,
    }


def _row_to_doc(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return example_document()
    try:
        rates = json.loads(row["rates_json"])
    except (TypeError, ValueError, json.JSONDecodeError):
        rates = DEFAULT_RATES
    if not isinstance(rates, dict):
        rates = DEFAULT_RATES
    confirmed = bool(row["confirmed"])
    return {
        "id": row["id"],
        "confirmed": confirmed,
        "example": not confirmed,
        "note": row["note"] or EXAMPLE_NOTE,
        "rates": rates,
        "updated_at": row["updated_at"],
    }


def ensure_default(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM storage_price_table WHERE id = ?", (PRICE_TABLE_ID,)
    ).fetchone()
    if row is not None:
        return _row_to_doc(row)
    now = utcnow()
    conn.execute(
        "INSERT INTO storage_price_table (id, confirmed, rates_json, note, updated_at) "
        "VALUES (?, 0, ?, ?, ?)",
        (PRICE_TABLE_ID, json.dumps(DEFAULT_RATES, ensure_ascii=False), EXAMPLE_NOTE, now),
    )
    conn.commit()
    return example_document() | {"updated_at": now}


def load(conn: sqlite3.Connection) -> dict[str, Any]:
    try:
        return ensure_default(conn)
    except sqlite3.OperationalError:
        return example_document()


def save(conn: sqlite3.Connection, *, rates: dict[str, Any] | None = None,
         confirmed: bool | None = None, note: str | None = None) -> dict[str, Any]:
    current = ensure_default(conn)
    next_rates = rates if isinstance(rates, dict) else current["rates"]
    next_confirmed = current["confirmed"] if confirmed is None else bool(confirmed)
    next_note = redact_text(note if note is not None else current["note"] or EXAMPLE_NOTE)[:800]
    now = utcnow()
    conn.execute(
        "UPDATE storage_price_table SET confirmed = ?, rates_json = ?, note = ?, "
        "updated_at = ? WHERE id = ?",
        (1 if next_confirmed else 0,
         json.dumps(next_rates, ensure_ascii=False),
         next_note, now, PRICE_TABLE_ID),
    )
    conn.commit()
    return load(conn)


def simulator_input(conn: sqlite3.Connection) -> dict[str, Any]:
    """Shape consumed by ``cost_sim.simulate`` — rates at top level + confirmed."""
    doc = load(conn)
    rates = dict(doc.get("rates") or {})
    rates["confirmed"] = bool(doc.get("confirmed"))
    rates["example"] = bool(doc.get("example"))
    rates["note"] = doc.get("note")
    return rates
