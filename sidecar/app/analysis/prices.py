"""Local storage-class price table — ordinary config, not a secret.

Stored in the settings table under ``price_table``. Ships an example schedule labelled as such. Dollar simulation stays a gap until
the operator confirms they have calibrated the table against their bill.
Credentials never belong here.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from ..core.clock import utcnow
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


_KEY = "price_table"


def _doc(stored: dict[str, Any] | None, updated_at: str | None = None) -> dict[str, Any]:
    if not isinstance(stored, dict):
        return example_document()
    rates = stored.get("rates") if isinstance(stored.get("rates"), dict) else DEFAULT_RATES
    confirmed = bool(stored.get("confirmed"))
    return {"id": PRICE_TABLE_ID, "confirmed": confirmed, "example": not confirmed,
            "note": stored.get("note") or EXAMPLE_NOTE, "rates": rates, "updated_at": updated_at}


def load(conn: sqlite3.Connection) -> dict[str, Any]:
    """The price table from the settings store (the example schedule until saved)."""
    try:
        row = conn.execute("SELECT value, updated_at FROM settings WHERE key = ?", (_KEY,)).fetchone()
    except sqlite3.OperationalError:
        return example_document()
    if row is None:
        return example_document()
    try:
        stored = json.loads(row["value"])
    except (TypeError, ValueError):
        stored = None
    return _doc(stored, row["updated_at"])


def save(conn: sqlite3.Connection, *, rates: dict[str, Any] | None = None,
         confirmed: bool | None = None, note: str | None = None) -> dict[str, Any]:
    current = load(conn)
    doc = {
        "rates": rates if isinstance(rates, dict) else current["rates"],
        "confirmed": current["confirmed"] if confirmed is None else bool(confirmed),
        "note": redact_text(note if note is not None else current["note"] or EXAMPLE_NOTE)[:800],
    }
    conn.execute("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                 (_KEY, json.dumps(doc, ensure_ascii=False), utcnow()))
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
