"""v4.0.0 — the storage estate: buckets, issues and their lifecycle.

The estate is the object; tasks are how work is done. What a survey or a config
review establishes outlives the task that asked: buckets and their posture are
remembered per account, and deterministic observations become Issues with a
lifecycle (open → fix proposed → resolved, and recurred when one comes back).
A fix is text the user applies; Verify is a read-only re-check. Model prose
never opens or resolves an Issue.

The golden test drives a real Agent Execution (fake OpenAI-compatible model)
against a real S3 server (moto, ``tests/live_s3.py``): survey → review →
Issues on the home estate → the user applies the generated fix → Verify
resolves it → the problem comes back → the next check marks it recurred.
"""

from __future__ import annotations

import sqlite3
import time

import boto3
import pytest
from botocore.config import Config

from app import config
from app.agent_runtime import prompt
from app.estate import rules, store
from app.migrations import apply_migrations
from tests.live_s3 import live_s3_endpoint  # noqa: F401

from .fake_model import FakeModel, text_turn, tool_turn

ACCESS = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
ESTATE_BUCKET = "estate-golden"


def _mem() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    apply_migrations(conn)
    for pid in ("p1",):
        conn.execute("INSERT INTO cloud_providers (id, name, provider_type, created_at, updated_at) "
                     "VALUES (?, 'prod', 's3', 'x', 'x')", (pid,))
    return conn


# --- rules -----------------------------------------------------------------------


def test_posture_decides_only_what_it_can_see():
    v = rules.evaluate_posture({"publicly_exposed": None, "encryption_status": "access_denied",
                                "public_access_block_status": "available",
                                "lifecycle_status": "not_configured"})
    # Unreadable exposure / encryption and an existing (maybe incomplete) block
    # decide nothing; no lifecycle at all means no multipart cleanup.
    assert v == {"no_abort_mpu": True}
    v = rules.evaluate_posture({"publicly_exposed": True, "encryption_status": "available"})
    assert v == {"public_exposure": True, "no_default_encryption": False}


def test_a_review_with_a_blind_spot_resolves_nothing():
    clean = {"success": True, "findings": [{"category": "Good", "title": "Default encryption enabled"}]}
    verdicts, _ = rules.evaluate_review("security", clean)
    assert verdicts["no_default_encryption"] is False and verdicts["public_exposure"] is False
    blind = {"success": True, "findings": [
        {"category": "Warning", "title": "Access denied reading bucket policy", "detail": "403"},
        {"category": "Warning", "title": "No default encryption", "detail": "none"}]}
    verdicts, details = rules.evaluate_review("security", blind)
    assert verdicts == {"no_default_encryption": True}
    assert details["no_default_encryption"] == "none"


def test_fixes_are_deterministic_text_never_applied():
    fix = rules.generate_fix("public_access_block_missing", "b1")
    assert fix["kind"] == "public_access_block"
    assert fix["command"].startswith("aws s3api put-public-access-block --bucket b1 ")
    assert all(fix["document"].values())
    assert rules.generate_fix("wildcard_principal", "b1") is None  # needs intent
    lc = rules.generate_fix("no_abort_mpu", "b1")
    assert "REPLACES" in " ".join(lc["notes"])


# --- lifecycle -------------------------------------------------------------------


def test_the_issue_lifecycle_is_driven_by_observations():
    conn = _mem()
    opened = store.observe(conn, "p1", "b1", {"no_default_encryption": True}, source="survey")
    assert [c["change"] for c in opened] == ["opened"]
    iid = opened[0]["issue_id"]
    # Silence (an undecided verdict) never resolves it.
    assert store.observe(conn, "p1", "b1", {"no_default_encryption": None}, source="survey") == []
    assert store.get_issue(conn, iid)["status"] == "open"
    fix = store.propose_fix(conn, iid)
    assert fix["kind"] == "default_encryption"
    assert store.get_issue(conn, iid)["status"] == "fix_proposed"
    assert store.observe(conn, "p1", "b1", {"no_default_encryption": False}, source="verify")[0]["change"] == "resolved"
    issue = store.get_issue(conn, iid)
    assert issue["status"] == "resolved" and issue["resolved_by"] == "verify"
    assert store.observe(conn, "p1", "b1", {"no_default_encryption": True}, source="watch")[0]["change"] == "recurred"
    issue = store.get_issue(conn, iid)
    assert issue["status"] == "recurred" and issue["resolved_at"] is None
    kinds = [e["kind"] for e in reversed(issue["events"])]
    assert kinds == ["opened", "fix_proposed", "resolved", "recurred"]


def test_an_accepted_risk_leaves_the_home_list_but_stays_known():
    conn = _mem()
    iid = store.observe(conn, "p1", "b1", {"public_exposure": True}, source="survey")[0]["issue_id"]
    store.set_accepted(conn, iid, True)
    assert store.get_issue(conn, iid)["status"] == "accepted"
    assert store.overview(conn)["open_issue_count"] == 0
    assert [i["id"] for i in store.list_issues(conn)] == [iid]
    store.set_accepted(conn, iid, False)
    assert store.get_issue(conn, iid)["status"] == "open"


def test_issues_read_most_severe_first_and_localized():
    conn = _mem()
    store.observe(conn, "p1", "b1", {"no_default_encryption": True}, source="survey")
    store.observe(conn, "p1", "b2", {"public_exposure": True}, source="survey")
    issues = store.list_issues(conn, lang="zh")
    assert [i["code"] for i in issues] == ["public_exposure", "no_default_encryption"]
    assert issues[0]["title"] == "存储桶可被公开访问"


def test_the_agent_starts_every_task_knowing_the_estate():
    conn = _mem()
    assert store.prompt_block(conn) is None
    store.upsert_bucket(conn, "p1", "b1", posture={"encryption_status": "not_configured"})
    store.observe(conn, "p1", "b1", {"no_default_encryption": True}, source="survey")
    block = store.prompt_block(conn)
    assert block["providers"][0]["known_buckets"] == 1
    assert block["open_issues"][0]["code"] == "no_default_encryption"
    # Status enums and booleans only — no posture document reaches the prompt.
    assert "posture" not in str(block)


# --- the golden task: real Agent Execution, real S3 server ------------------------


def _s3(endpoint: str):
    return boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1",
                        aws_access_key_id=ACCESS, aws_secret_access_key=SECRET,
                        config=Config(s3={"addressing_style": "path"}))


def _settled(client, task_id, exec_id, timeout=60.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        row = client.get(f"/agent-tasks/{task_id}/executions/{exec_id}").json()
        if row["status"] not in ("queued", "running"):
            return row
        time.sleep(0.05)
    raise AssertionError("execution never settled")


@pytest.fixture()
def storage(client, live_s3_endpoint):  # noqa: F811
    s3 = _s3(live_s3_endpoint)
    try:
        s3.create_bucket(Bucket=ESTATE_BUCKET)
    except s3.exceptions.BucketAlreadyOwnedByYou:
        pass
    pid = client.post("/cloud-providers", json={
        "name": "estate-live", "provider_type": "s3-compatible",
        "endpoint_url": live_s3_endpoint, "region": "us-east-1",
        "addressing_style": "path", "access_key": ACCESS, "secret_key": SECRET,
        "mode": "readonly",
    }).json()["id"]
    return pid, s3


def test_golden_task_survey_review_fix_verify_recur(client, storage):
    pid, s3 = storage
    with FakeModel([
        tool_turn("survey_account", {"provider_id": pid}),
        tool_turn("review_bucket_config", {"provider_id": pid, "bucket": ESTATE_BUCKET}),
        text_turn("Surveyed the account and reviewed estate-golden."),
    ]) as model:
        client.post("/model-providers", json={
            "name": "fake", "provider_type": "openai-compatible", "base_url": model.base_url,
            "model": "fake-model", "api_key": "not-a-real-key"})
        task = client.post("/sessions", json={"title": "look after the account"}).json()
        r = client.post(f"/agent-tasks/{task['id']}/executions",
                        json={"direction": "Survey the account", "turn_id": "t1"})
        assert r.status_code == 201, r.text
        row = _settled(client, task["id"], r.json()["execution"]["id"])
    assert row["status"] == "completed", row

    estate = client.get("/estate").json()
    mine = next(p for p in estate["providers"] if p["provider_id"] == pid)
    assert mine["bucket_count"] >= 1 and mine["last_checked_at"]
    assert mine["watch"]["enabled"] is False  # watch is opt-in, off by default

    issues = client.get("/issues", params={"provider_id": pid}).json()
    by_code = {(i["bucket"], i["code"]): i for i in issues}
    pab = by_code[(ESTATE_BUCKET, "public_access_block_missing")]
    assert pab["status"] == "open" and pab["severity"] == "medium"
    # The task that found it is where the home list opens it.
    assert pab["source_task_id"] == task["id"]
    # The Agent never opened an issue from prose: every one has a deterministic source.
    for issue in issues:
        detail = client.get(f"/issues/{issue['id']}").json()
        assert detail["events"][-1]["source"] in ("survey", "review")

    # Generate the fix — text for the user; storage is untouched.
    fixed = client.post(f"/issues/{pab['id']}/fix").json()
    assert fixed["status"] == "fix_proposed"
    assert "put-public-access-block" in fixed["fix"]["command"]
    with pytest.raises(s3.exceptions.ClientError):
        s3.get_public_access_block(Bucket=ESTATE_BUCKET)

    # Verify before the user applied it: still present, state kept.
    out = client.post(f"/issues/{pab['id']}/verify").json()
    assert out["result"] == "still_present" and out["issue"]["status"] == "fix_proposed"

    # The user applies the generated fix with their own credentials.
    s3.put_public_access_block(Bucket=ESTATE_BUCKET,
                               PublicAccessBlockConfiguration=fixed["fix"]["document"])
    out = client.post(f"/issues/{pab['id']}/verify").json()
    assert out["result"] == "resolved"
    assert out["issue"]["status"] == "resolved" and out["issue"]["resolved_by"] == "verify"

    # The problem comes back; the next read-only check says so.
    s3.delete_public_access_block(Bucket=ESTATE_BUCKET)
    out = client.post(f"/issues/{pab['id']}/verify").json()
    assert out["result"] == "still_present" and out["issue"]["status"] == "recurred"
    kinds = [e["kind"] for e in reversed(out["issue"]["events"])]
    assert kinds[:3] == ["opened", "fix_proposed", "verified"]
    assert "resolved" in kinds and kinds[-2:] == ["recurred", "verified"]

    # Every verify read is recorded like any tool call.
    conn = sqlite3.connect(str(config.db_path()))
    try:
        n = conn.execute("SELECT COUNT(*) FROM tool_calls WHERE tool_name = 'review_bucket_security' "
                         "AND input_json_sanitized LIKE ?", (f"%{ESTATE_BUCKET}%",)).fetchone()[0]
        assert n >= 4  # the review + three verifies
    finally:
        conn.close()


def test_the_next_task_is_grounded_in_the_estate(client, storage):
    pid, _s3client = storage
    with FakeModel([tool_turn("survey_account", {"provider_id": pid}), text_turn("ok"),
                    text_turn("I already know this account.")]) as model:
        client.post("/model-providers", json={
            "name": "fake", "provider_type": "openai-compatible", "base_url": model.base_url,
            "model": "fake-model", "api_key": "not-a-real-key"})
        first = client.post("/sessions", json={"title": "survey"}).json()
        r = client.post(f"/agent-tasks/{first['id']}/executions",
                        json={"direction": "Survey", "turn_id": "t1"})
        _settled(client, first["id"], r.json()["execution"]["id"])
        second = client.post("/sessions", json={"title": "fresh task"}).json()
        r = client.post(f"/agent-tasks/{second['id']}/executions",
                        json={"direction": "What do you know?", "turn_id": "t1"})
        _settled(client, second["id"], r.json()["execution"]["id"])
    text = " ".join(str(m.get("content") or "") for m in model.requests[-1]["messages"])
    assert "known_estate:" in text and ESTATE_BUCKET in text


def test_routes_refuse_what_they_cannot_do(client):
    assert client.get("/issues/nope").status_code == 404
    assert client.post("/issues/nope/verify").status_code == 404
    assert client.get("/issues", params={"status": "bogus"}).status_code == 422


def test_prompt_module_injects_the_estate_block():
    src = open(prompt.__file__, encoding="utf-8").read()
    assert '"known_estate:\\n"' in src


def test_a_deleted_provider_takes_its_issues_off_the_home():
    conn = _mem()
    store.observe(conn, "p1", "b1", {"public_exposure": True}, source="survey")
    store.observe(conn, "gone", "b9", {"public_exposure": True}, source="survey")
    assert [i["provider_id"] for i in store.list_issues(conn)] == ["p1"]
    assert all(i["provider_id"] == "p1" for i in store.prompt_block(conn)["open_issues"])
