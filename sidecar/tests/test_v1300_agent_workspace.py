"""v13 — the Agent workspace keeps deterministic data out of later turns.

The current Turn still reads the tool result it actually received. A later
Turn replays only a compact, enveloped digest, so a survey table does not tax
every follow-up. The full result remains in the item stream for the window.
"""

from __future__ import annotations

import json

from app.agent import safety
from app.agent.recorder import _history_digest


def test_a_large_survey_replays_as_an_enveloped_digest_without_rows():
    result = {
        "success": True,
        "issues": [{"code": "public_exposure", "title": "Public access block not fully enabled",
                    "severity": "high", "buckets": 12}],
        "coverage": {"surveyed": 120, "whole_account": True},
        "estate_changes": {"opened": 12},
        "buckets": {
            "columns": ["bucket", "region", "issues"],
            "common": {"region": "us-east-1"},
            "rows": [[f"bucket-{n}", "us-east-1", ["public_exposure"]] for n in range(120)],
        },
    }
    digest = _history_digest("survey_account", result, "120 buckets")
    assert digest is not None and digest.startswith(safety.UNTRUSTED_OPEN)
    inner = digest[len(safety.UNTRUSTED_OPEN):].rsplit(safety.UNTRUSTED_CLOSE, 1)[0]
    doc = json.loads(inner)
    assert doc["buckets"]["count"] == 120
    assert "rows" not in doc["buckets"]
    assert doc["issues"][0]["severity"] == "high"
    assert len(digest) < 4_000


def test_a_large_estate_result_keeps_issue_facts_and_names_only():
    result = {
        "success": True,
        "bucket_count": 40,
        "buckets": [{"bucket": f"b{n}", "region": "us-east-1", "publicly_exposed": bool(n % 2)}
                    for n in range(40)],
        "issues": [{"id": str(n), "bucket": f"b{n}", "severity": "medium",
                    "title": "No default encryption", "status": "open"} for n in range(40)],
    }
    digest = _history_digest("query_estate", result, "40 buckets")
    assert digest is not None and digest.startswith(safety.UNTRUSTED_OPEN)
    inner = digest[len(safety.UNTRUSTED_OPEN):].rsplit(safety.UNTRUSTED_CLOSE, 1)[0]
    doc = json.loads(inner)
    assert doc["bucket_count"] == 40
    assert "b0" in doc["buckets"]
    assert "publicly_exposed" not in json.dumps(doc["buckets"])
    assert doc["issues"][0]["status"] == "open"
    assert len(digest) < 4_000
