"""v12 release fix: the UI renders a complete deterministic result even when
the model's enveloped copy is longer than the 24k window copy.

`detail_truncated` used to compare the UI copy with `model_output`, so a normal
survey (whose model text carries the untrusted-data envelope) was flagged as
cut and the window fell back to the model's prose table. It now means exactly
what it says: the 24 000-character UI detail was actually cut.
"""

from __future__ import annotations

import json

from app.agent.recorder import Recorder
from app.core import store


def _outputs(conn, task_id: str) -> list[dict]:
    rows = conn.execute("SELECT payload FROM items WHERE task_id = ? AND type = 'tool_output' ORDER BY seq",
                        (task_id,)).fetchall()
    return [json.loads(r["payload"]) for r in rows]


def test_detail_truncated_means_the_ui_copy_was_cut(conn):
    task = store.create_task(conn, "t")
    turn = store.create_turn(conn, task["id"], "look", status="running")
    rec = Recorder(task["id"], turn["id"])
    complete = {"buckets": {"columns": ["bucket"], "rows": [["acme-www"]]}, "issues": []}
    try:
        rec.tool_started("a", "survey_account", {}, "prod")
        # A model copy longer than the 24k UI copy must not mark a complete result as cut.
        rec.tool_finished("a", "survey_account", True, "1 bucket", complete, 12, model_text="x" * 30_000)
        rec.tool_started("b", "query_estate", {}, "prod")
        rec.tool_finished("b", "query_estate", True, "large", {"text": "y" * 25_000}, 1)
    finally:
        rec.close()

    small, large = _outputs(conn, task["id"])
    assert small["detail_truncated"] is False
    assert json.loads(small["detail"]) == complete
    assert large["detail_truncated"] is True
    assert len(large["detail"]) == 24_000
