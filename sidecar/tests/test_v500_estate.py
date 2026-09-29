"""The storage estate: buckets, issues and their lifecycle.

The estate is the object; tasks are how work is done. What a survey or a config
review establishes outlives the task that asked: buckets and their posture are
remembered per account, and deterministic observations become Issues with a
lifecycle (open → fix proposed → resolved, and recurred when one comes back).
A fix is text the user applies; Verify is a read-only re-check. Model prose
never opens or resolves an Issue.

The golden test drives a real Agent turn (fake OpenAI-compatible model)
against a real S3 server (moto, ``tests/live_s3.py``): survey → review →
Issues on the home estate → the user applies the generated fix → Verify
resolves it → the problem comes back → the next check marks it recurred.
"""

from __future__ import annotations

import time

import boto3
import pytest
from botocore.config import Config

from app.agent import prompt
from app.estate import rules, store
from tests.live_s3 import live_s3_endpoint  # noqa: F401

from .fake_model import FakeModel, text_turn, tool_turn

ACCESS = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
ESTATE_BUCKET = "estate-golden"


@pytest.fixture()
def mem(conn):
    conn.execute("INSERT INTO cloud_providers (id, name, provider_type, created_at, updated_at) "
                 "VALUES ('p1', 'prod', 's3', 'x', 'x')")
    conn.commit()
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


def test_the_issue_lifecycle_is_driven_by_observations(mem):
    conn = mem
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


def test_an_accepted_risk_leaves_the_home_list_but_stays_known(mem):
    conn = mem
    iid = store.observe(conn, "p1", "b1", {"public_exposure": True}, source="survey")[0]["issue_id"]
    store.set_accepted(conn, iid, True)
    assert store.get_issue(conn, iid)["status"] == "accepted"
    assert store.overview(conn)["open_issue_count"] == 0
    assert [i["id"] for i in store.list_issues(conn)] == [iid]
    store.set_accepted(conn, iid, False)
    assert store.get_issue(conn, iid)["status"] == "open"


def test_issues_read_most_severe_first_and_localized(mem):
    conn = mem
    store.observe(conn, "p1", "b1", {"no_default_encryption": True}, source="survey")
    store.observe(conn, "p1", "b2", {"public_exposure": True}, source="survey")
    issues = store.list_issues(conn, lang="zh")
    assert [i["code"] for i in issues] == ["public_exposure", "no_default_encryption"]
    assert issues[0]["title"] == "存储桶可被公开访问"


def test_the_agent_starts_every_task_knowing_the_estate(mem):
    conn = mem
    assert store.digest(conn) is None
    store.upsert_bucket(conn, "p1", "b1", posture={"encryption_status": "not_configured"})
    store.observe(conn, "p1", "b1", {"no_default_encryption": True}, source="survey")
    block = store.digest(conn)
    assert block["providers"][0]["known_buckets"] == 1
    assert block["open_issues"][0]["code"] == "no_default_encryption"
    # Status enums and booleans only — no posture document reaches the prompt.
    assert "posture" not in str(block)


# --- the golden task: real Agent Execution, real S3 server ------------------------


def _s3(endpoint: str):
    return boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1",
                        aws_access_key_id=ACCESS, aws_secret_access_key=SECRET,
                        config=Config(s3={"addressing_style": "path"}))


def _settled(client, task_id, timeout=60.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = client.get(f"/tasks/{task_id}").json()
        if snap["state"] not in ("working", "queued"):
            return snap
        time.sleep(0.05)
    raise AssertionError("turn never settled")


def _use_model(client, model):
    client.post("/providers/models", json={"name": "fake", "kind": "openai-compatible",
                                           "base_url": model.base_url, "model": "fake-model"})


@pytest.fixture()
def storage(client, live_s3_endpoint):  # noqa: F811
    s3 = _s3(live_s3_endpoint)
    try:
        s3.create_bucket(Bucket=ESTATE_BUCKET)
    except s3.exceptions.BucketAlreadyOwnedByYou:
        pass
    pid = client.post("/providers/clouds", json={
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
        _use_model(client, model)
        task = client.post("/tasks", json={"direction": "Survey the account"}).json()["task"]
        snap = _settled(client, task["id"])
    assert snap["turns"][0]["status"] == "completed", snap["turns"]
    assert {a["kind"] for a in snap["artifacts"]} == {"survey", "review"}

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

    # Every verify read is audited like any tool call.
    from app.db import connect
    conn = connect()
    try:
        n = conn.execute("SELECT COUNT(*) FROM audit WHERE action = 'tool.review_bucket_security' "
                         "AND target = ?", (ESTATE_BUCKET,)).fetchone()[0]
        assert n >= 3  # three verifies (the review inside the turn is one review_bucket_config call)
    finally:
        conn.close()


def test_the_next_task_is_grounded_in_the_estate(client, storage):
    pid, _s3client = storage
    with FakeModel([tool_turn("survey_account", {"provider_id": pid}), text_turn("ok"),
                    text_turn("I already know this account.")]) as model:
        _use_model(client, model)
        first = client.post("/tasks", json={"direction": "Survey"}).json()["task"]
        _settled(client, first["id"])
        second = client.post("/tasks", json={"direction": "What do you know?"}).json()["task"]
        _settled(client, second["id"])
    text = " ".join(str(m.get("content") or "") for m in model.requests[-1]["messages"])
    assert "estate_digest:" in text and ESTATE_BUCKET in text


def test_routes_refuse_what_they_cannot_do(client):
    assert client.get("/issues/nope").status_code == 404
    assert client.post("/issues/nope/verify").status_code == 404
    assert client.get("/issues", params={"status": "bogus"}).status_code == 422


def test_prompt_module_injects_the_estate_digest():
    src = open(prompt.__file__, encoding="utf-8").read()
    assert '"estate_digest: "' in src


def test_a_deleted_provider_takes_its_issues_with_it(mem):
    conn = mem
    conn.execute("INSERT INTO cloud_providers (id, name, provider_type, created_at, updated_at) "
                 "VALUES ('gone', 'old', 's3', 'x', 'x')")
    store.observe(conn, "p1", "b1", {"public_exposure": True}, source="survey")
    store.observe(conn, "gone", "b9", {"public_exposure": True}, source="survey")
    conn.execute("DELETE FROM cloud_providers WHERE id = 'gone'")
    conn.commit()
    assert [i["provider_id"] for i in store.list_issues(conn)] == ["p1"]
    assert all(i["provider_id"] == "p1" for i in store.digest(conn)["open_issues"])


def test_a_fix_targets_the_provider_the_issue_was_seen_on(mem):
    fix = rules.generate_fix("no_default_encryption", "b1", endpoint_url="http://minio.local:9000",
                             region="us-east-1")
    assert fix["command"].startswith("aws --endpoint-url http://minio.local:9000 --region us-east-1 "
                                     "s3api put-bucket-encryption --bucket b1 ")
    assert "http://minio.local:9000" in fix["notes"][0]
    conn = mem
    conn.execute("UPDATE cloud_providers SET endpoint_url = 'http://minio.local:9000' WHERE id = 'p1'")
    iid = store.observe(conn, "p1", "b1", {"no_default_encryption": True}, source="survey")[0]["issue_id"]
    assert "--endpoint-url http://minio.local:9000" in store.propose_fix(conn, iid)["command"]


def test_accepted_risks_never_crowd_out_what_needs_care(mem):
    conn = mem
    for i in range(60):
        iid = store.observe(conn, "p1", f"pub-{i:02d}", {"public_exposure": True}, source="survey")[0]["issue_id"]
        store.set_accepted(conn, iid, True)
    for i in range(3):
        store.observe(conn, "p1", f"enc-{i}", {"no_default_encryption": True}, source="survey")
    out = store.overview(conn)
    assert out["open_issue_count"] == 3
    assert {i["code"] for i in out["issues"]} == {"no_default_encryption"}


def test_a_scoped_survey_never_forgets_buckets_outside_its_scope(mem):
    conn = mem
    store.upsert_bucket(conn, "p1", "b-out", posture={})
    iid = store.observe(conn, "p1", "b-out", {"public_exposure": True}, source="survey")[0]["issue_id"]
    # A survey that did not see the whole account (scoped / truncated) forgets nothing.
    store.ingest_survey(conn, "p1", {"whole_account": False, "buckets": [{"bucket_name": "b-in"}]})
    assert store.get_issue(conn, iid)["status"] == "open"
    assert conn.execute("SELECT COUNT(*) FROM estate_buckets WHERE bucket = 'b-out'").fetchone()[0] == 1
    # One that did, forgets the bucket it no longer lists — and its issues resolve.
    store.ingest_survey(conn, "p1", {"whole_account": True, "buckets": [{"bucket_name": "b-in"}]})
    assert conn.execute("SELECT COUNT(*) FROM estate_buckets WHERE bucket = 'b-out'").fetchone()[0] == 0
