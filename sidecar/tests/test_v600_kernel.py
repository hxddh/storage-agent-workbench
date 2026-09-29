"""v6 kernel: a call's stop signal is set by the turn's Stop or by the call's own timeout."""

from __future__ import annotations

import threading

from app.agent.tools.registry import CallContext, StopSignal, TurnContext


def _turn() -> TurnContext:
    return TurnContext(task_id="t", turn_id="u", cancel=threading.Event(), recorder=None)


def test_a_turn_stop_reaches_every_call():
    turn = _turn()
    a, b = CallContext(turn, "c1", "x"), CallContext(turn, "c2", "y")
    assert not a.cancelled and not b.cancelled
    turn.cancel.set()
    assert a.cancelled and b.cancelled


def test_one_call_timing_out_stops_only_that_call():
    turn = _turn()
    a, b = CallContext(turn, "c1", "x"), CallContext(turn, "c2", "y")
    assert isinstance(a.stop, StopSignal)
    a.stop.set()
    assert a.cancelled
    assert not b.cancelled
    assert not turn.cancel.is_set()


def test_a_failure_on_a_branch_left_behind_does_not_need_attention(conn):
    from app.core import store

    task = store.create_task(conn, "t")
    first = store.create_turn(conn, task["id"], "look")
    store.set_turn_status(conn, first["id"], "failed")
    assert store.list_tasks(conn)[0]["state"] == "needs_attention"
    # A later turn answers and becomes the head the task is read at.
    second = store.create_turn(conn, task["id"], "look again")
    store.set_turn_status(conn, second["id"], "completed")
    store.set_head(conn, task["id"], second["id"])
    assert store.head_status(conn, task["id"]) == "completed"
    assert store.list_tasks(conn)[0]["state"] == "ready"
    # Switching back to the failed version reads as needing attention again.
    store.set_head(conn, task["id"], first["id"])
    assert store.list_tasks(conn)[0]["state"] == "needs_attention"


# --- estate view + notes ------------------------------------------------------------

def _provider(client, name="acct"):
    return client.post("/providers/clouds", json={
        "name": name, "provider_type": "s3-compatible", "endpoint_url": "http://127.0.0.1:9",
        "region": "us-east-1", "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "mode": "readonly"}).json()["id"]


def test_a_bucket_page_tells_its_story(client):
    from app.db import connect
    from app.estate import store as estate

    pid = _provider(client)
    conn = connect()
    try:
        exposed = {"bucket_name": "b1", "region": "us-east-1", "publicly_exposed": True,
                   "encryption_status": "available"}
        estate.ingest_survey(conn, pid, {"buckets": [exposed]})
        estate.ingest_survey(conn, pid, {"buckets": [exposed]})  # unchanged: no new history row
        estate.ingest_survey(conn, pid, {"buckets": [exposed | {"publicly_exposed": False}]})
    finally:
        conn.close()

    listing = client.get(f"/estate/providers/{pid}/buckets").json()
    assert [b["bucket"] for b in listing["buckets"]] == ["b1"]
    page = client.get(f"/estate/providers/{pid}/buckets/b1").json()
    posture = [t for t in page["timeline"] if t["kind"] == "posture"]
    assert len(posture) == 2 and posture[-1]["first"] is True
    assert posture[0]["changed"] == ["publicly_exposed"]
    events = {t["event"] for t in page["timeline"] if t["kind"] == "issue"}
    assert {"opened", "resolved"} <= events
    assert client.get(f"/estate/providers/{pid}/buckets/nope").status_code == 404


def test_notes_are_visible_editable_bounded_and_reach_the_digest(client):
    from app.agent.prompt import dynamic_context
    from app.db import connect

    pid = _provider(client)
    n = client.post("/notes", json={"text": "Owned by the data team; public on purpose for the CDN.",
                                    "provider_id": pid, "bucket": "cdn-assets"}).json()
    assert n["source"] == "user"
    # Secrets never stay in a note.
    s = client.post("/notes", json={"text": "key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "provider_id": pid}).json()
    assert "EXAMPLEKEY" not in s["text"]
    assert client.post("/notes", json={"text": "x", "bucket": "orphan"}).status_code == 422
    edited = client.patch(f"/notes/{n['id']}", json={"text": "Owned by the data team."}).json()
    assert edited["text"] == "Owned by the data team."

    conn = connect()
    try:
        ctx = dynamic_context(conn)
        # Notes reach the model as data, inside the untrusted-data envelope.
        block = ctx[ctx.index("estate_notes"):]
        assert "Owned by the data team." in block
        assert block.index("<<external_untrusted_data>>") < block.index("Owned by the data team.")
        actions = {r["action"] for r in conn.execute("SELECT action FROM audit").fetchall()}
        assert {"note.add", "note.edit"} <= actions
    finally:
        conn.close()
    assert client.delete(f"/notes/{n['id']}").status_code == 204
    assert all(x["id"] != n["id"] for x in client.get("/notes").json())


def test_accepting_a_risk_with_a_reason_keeps_it_as_a_note(client):
    from app.db import connect
    from app.estate import store as estate

    pid = _provider(client)
    conn = connect()
    try:
        estate.ingest_survey(conn, pid, {"buckets": [{"bucket_name": "b2", "publicly_exposed": True}]})
    finally:
        conn.close()
    issue = client.get("/issues", params={"provider_id": pid}).json()[0]
    out = client.post(f"/issues/{issue['id']}/accept", json={"reason": "Static website bucket."}).json()
    assert out["status"] == "accepted"
    page = client.get(f"/estate/providers/{pid}/buckets/b2").json()
    assert page["notes"][0]["source"] == "accept" and page["notes"][0]["issue_id"] == issue["id"]


# --- fix packs + impact preview -------------------------------------------------------

def test_fix_packs_come_in_cli_terraform_and_json_and_quote_hostile_names():
    import json as _json
    import shlex

    from app.estate import rules

    fix = rules.generate_fix("public_access_block_missing", "acme-www", endpoint_url="http://minio:9000", region="us-east-1")
    kinds = [f["format"] for f in fix["formats"]]
    assert kinds == ["cli", "terraform", "json"]
    tf = fix["formats"][1]["text"]
    assert 'resource "aws_s3_bucket_public_access_block" "acme_www"' in tf and "restrict_public_buckets = true" in tf
    assert "endpoints" in tf  # the custom endpoint belongs in the user's provider block
    assert _json.loads(fix["formats"][2]["text"]) == fix["document"]

    evil = "x; rm -rf ~ ${jndi}"
    # A hostile name gets no generated command at all...
    assert rules.generate_fix("no_default_encryption", evil) is None
    # ...and the layers beneath still quote and escape it (defence in depth).
    from app.estate import fixpacks
    raw = rules._fix("no_default_encryption", evil)
    argv = shlex.split(raw["command"])
    assert argv[argv.index("--bucket") + 1] == evil  # one argument, never a second command
    tf = fixpacks.terraform(raw, evil)
    assert "$${jndi}" in tf and '"x_' in tf.split("\n")[0]

    lc = rules.generate_fix("noncurrent_never_expire", "b")
    tf = next(f["text"] for f in lc["formats"] if f["format"] == "terraform")
    assert "noncurrent_version_expiration" in tf and "noncurrent_days = 30" in tf


def _s3_log_line(bucket, requester, key, ts="06/Feb/2026:00:00:38 +0000"):
    return (f"79a59df900b949e5 {bucket} [{ts}] 192.0.2.3 {requester} 3E57427F3EXAMPLE REST.GET.OBJECT {key} "
            f'"GET /{bucket}/{key} HTTP/1.1" 200 - 2662 2662 70 10 "-" "curl/8" - s9lzHYrFp76ZVxRcpX9+5cjAnEH2ROuNkd2BHfIa6UkFVdtjf5mKR3/eTPFvsiP/XV/VLi31234= SigV4 ECDHE-RSA-AES128-GCM-SHA256 AuthHeader {bucket}.s3.amazonaws.com TLSv1.2 - -')


def test_the_impact_preview_reads_evidence_and_says_when_it_cannot_tell(client):
    from app.db import connect
    from app.estate import store as estate

    pid = _provider(client, "logs")
    conn = connect()
    try:
        estate.ingest_survey(conn, pid, {"buckets": [
            {"bucket_name": "site", "publicly_exposed": True, "lifecycle_status": "available"},
            {"bucket_name": "quiet", "public_access_block_status": "not_configured", "lifecycle_status": "not_configured"}]})
    finally:
        conn.close()
    issues = {(i["bucket"], i["code"]): i for i in client.get("/issues", params={"provider_id": pid}).json()}

    # No access log yet: the preview says it cannot tell.
    out = client.get(f"/issues/{issues[('site', 'public_exposure')]['id']}/impact").json()
    assert out["verdict"] == "unknown" and "Cannot tell" in out["gaps"][0]

    # Attach an S3 server access log: 2 of 3 requests to `site` were anonymous.
    task = client.post("/tasks", json={}).json()["task"]
    lines = [_s3_log_line("site", "-", "img/a.png"), _s3_log_line("site", "-", "img/b.png"),
             _s3_log_line("site", "arn:aws:iam::123456789012:user/ci", "build/x.tgz"),
             _s3_log_line("quiet", "arn:aws:iam::123456789012:user/ci", "k")]
    r = client.post(f"/tasks/{task['id']}/files", files={"file": ("access.log", "\n".join(lines).encode())},
                    data={"dataset_type": "access_log"})
    assert r.status_code in (200, 201), r.text
    # Not analyzed yet: the preview never ingests; it says what it did not read.
    out = client.get(f"/issues/{issues[('site', 'public_exposure')]['id']}/impact").json()
    assert out["verdict"] == "unknown" and "not been analyzed" in " ".join(out["gaps"])
    from app.engines import datasets
    conn = connect()
    try:
        datasets.ensure_ingested(conn, datasets.list_for_task(conn, task["id"])[0])
    finally:
        conn.close()
    # Attached twice (same file): counted once.
    client.post(f"/tasks/{task['id']}/files", files={"file": ("access.log", "\n".join(lines).encode())},
                data={"dataset_type": "access_log"})
    out = client.get(f"/issues/{issues[('site', 'public_exposure')]['id']}/impact").json()
    assert out["verdict"] == "caution"
    assert any("matched by bucket name" in g for g in out["gaps"])
    anon = next(p for p in out["points"] if p["evidence"] == "access_log" and "count" in p)
    assert (anon["count"], anon["total"]) == (2, 3)
    assert any("img/" in p["text"] for p in out["points"])
    # Aggregates only: no requester ARN, no IP, no raw line in the preview.
    assert "arn:aws" not in str(out) and "192.0.2.3" not in str(out)

    out = client.get(f"/issues/{issues[('quiet', 'public_access_block_missing')]['id']}/impact",
                     params={"lang": "zh"}).json()
    assert out["verdict"] == "low" and "没有匿名请求" in out["points"][0]["text"]

    # Lifecycle: an existing configuration would be replaced; none means nothing is.
    site_mpu = issues.get(("site", "no_abort_mpu"))
    quiet_mpu = issues[("quiet", "no_abort_mpu")]
    assert client.get(f"/issues/{quiet_mpu['id']}/impact").json()["verdict"] == "low"
    if site_mpu:
        assert client.get(f"/issues/{site_mpu['id']}/impact").json()["verdict"] == "caution"


def test_the_agent_keeps_a_note_and_previews_a_fix_in_a_real_turn(client):
    from app.db import connect
    from app.estate import store as estate

    from .fake_model import FakeModel, text_turn, tool_turn
    from .test_v500_estate import _settled, _use_model

    pid = _provider(client, "turn")
    conn = connect()
    try:
        estate.ingest_survey(conn, pid, {"buckets": [{"bucket_name": "b9", "encryption_status": "not_configured"}]})
    finally:
        conn.close()
    iid = client.get("/issues", params={"provider_id": pid}).json()[0]["id"]
    with FakeModel([
        tool_turn("fix_preview", {"issue_id": iid}),
        tool_turn("note", {"text": "b9 holds build caches; encryption is wanted.", "provider_id": pid, "bucket": "b9"}),
        text_turn("Here is the fix."),
    ]) as model:
        _use_model(client, model)
        task = client.post("/tasks", json={"direction": "Show me the fix for b9"}).json()["task"]
        snap = _settled(client, task["id"])
    outs = {i["payload"]["name"]: i["payload"] for i in snap["items"] if i["type"] == "tool_output"}
    assert outs["fix_preview"]["ok"] and outs["note"]["ok"]
    notes = client.get("/notes", params={"provider_id": pid, "bucket": "b9"}).json()
    assert notes[0]["source"] == "agent" and notes[0]["task_id"] == task["id"]
    # Previewing never changes the issue: only the user proposes a fix.
    assert client.get(f"/issues/{iid}").json()["status"] == "open"


def test_review_fixes_stored_fixes_names_accept_reasons_and_note_limits(client):
    import json as _json

    from app.db import connect
    from app.estate import notes, rules
    from app.estate import store as estate

    # A name with shell metacharacters gets no generated command at all.
    assert rules.generate_fix("no_default_encryption", "x&calc") is None
    assert rules.generate_fix("no_default_encryption", "acme_www.v2") is not None

    pid = _provider(client, "old")
    conn = connect()
    try:
        estate.ingest_survey(conn, pid, {"buckets": [{"bucket_name": "b1", "publicly_exposed": True}]})
        iid = conn.execute("SELECT id FROM issues WHERE provider_id = ?", (pid,)).fetchone()["id"]
        # A fix stored before v6 (unquoted text, no formats) is never served as stored.
        conn.execute("UPDATE issues SET fix = ? WHERE id = ?",
                     (_json.dumps({"kind": "public_access_block", "command": "aws s3api x --bucket b1; rm -rf ~"}), iid))
        conn.commit()
    finally:
        conn.close()
    served = client.get(f"/issues/{iid}").json()["fix"]
    assert "rm -rf" not in served["command"] and [f["format"] for f in served["formats"]] == ["cli", "terraform", "json"]

    # Un-accepting drops the reason it was acceptable; accepting again keeps one note.
    client.post(f"/issues/{iid}/accept", json={"reason": "Static site."})
    client.post(f"/issues/{iid}/accept", json={"accepted": False})
    assert [n for n in client.get("/notes").json() if n["source"] == "accept"] == []

    # Scoped lists are filtered in SQL; the Agent's notes are trimmed before the user's.
    conn = connect()
    try:
        client.post("/notes", json={"text": "estate-wide"})
        client.post("/notes", json={"text": "account", "provider_id": pid})
        assert [n["text"] for n in notes.list_notes(conn, exact=True)] == ["estate-wide"]
        assert [n["text"] for n in notes.list_notes(conn, provider_id=pid, exact=True)] == ["account"]
        old_max, notes.MAX_NOTES = notes.MAX_NOTES, 3
        try:
            notes.add(conn, "agent 1", source="agent")
            notes.add(conn, "agent 2", source="agent")
        finally:
            notes.MAX_NOTES = old_max
        left = {n["text"] for n in notes.list_notes(conn)}
        assert {"estate-wide", "account"} <= left and len(left) == 3
        assert conn.execute("SELECT COUNT(*) FROM audit WHERE action = 'note.trim'").fetchone()[0] >= 1
    finally:
        conn.close()


def test_posture_history_is_seeded_from_what_was_known_before():
    from app.migrations import MIGRATIONS
    sql = dict((v, q) for v, _, q in MIGRATIONS)[2]
    assert "INSERT INTO posture_history" in sql and "FROM estate_buckets" in sql


def test_a_refused_websocket_retries_the_same_turn_over_http_once(client, monkeypatch):
    from app.agent import runtime as rt

    from .fake_model import FakeModel, text_turn
    from .test_v500_estate import _settled, _use_model

    calls: list[int] = []
    original = rt.Runtime._stream_turn

    async def flaky(self, *args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            return {"status": "retry_http", "error": "websocket refused", "usage": None}
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(rt.Runtime, "_stream_turn", flaky)
    with FakeModel([text_turn("Answered over HTTP.")]) as model:
        _use_model(client, model)
        task = client.post("/tasks", json={"direction": "hello"}).json()["task"]
        snap = _settled(client, task["id"])
    assert len(calls) == 2
    assert snap["turns"][-1]["status"] == "completed"
    assert any(i["type"] == "agent_message" and "HTTP" in i["payload"]["text"] for i in snap["items"])
