"""The v8 tool set: fewer, broader tools with no capability lost.

Pins the registered names, that the MCP bridge never exposes the estate's
memory, that the merged tools reach the same engine reads (and the estate sees
exactly the aspects that ran), and that a past call under a retired name still
replays as ordinary model input.
"""

from __future__ import annotations

import threading

import pytest

from app.agent import tools as _tools  # noqa: F401
from app.agent.session import to_input
from app.agent.tools import config as config_tools
from app.agent.tools import registry
from app.api import mcp
from app.s3 import config_tools as ct
from app.s3 import tools as s3

NAMES = {
    "core": {"read_skill", "query_estate", "fix_preview", "note", "record_conclusion", "list_buckets", "head_bucket"},
    "probes": {"get_bucket_location", "test_addressing_style", "inspect_endpoint_tls", "measure_request_latency",
               "diagnose_presigned_url"},
    "objects": {"list_objects", "list_object_versions", "list_multipart_uploads", "list_upload_parts",
                "inspect_object", "test_object_read", "preview_object"},
    "config": {"get_bucket_config_detail", "review_bucket_performance_profile", "review_bucket_config"},
    "account": {"survey_account", "compare_to_last_survey"},
    "files": {"list_uploaded_files", "analyze_uploaded_file", "aggregate_uploaded_file", "import_evidence"},
    "advice": {"triage_error", "simulate_storage_cost"},
}
RETIRED = ("get_bucket_config_summary", "review_bucket_security", "review_bucket_lifecycle",
           "review_bucket_observability", "review_bucket_cost_optimization", "head_object", "get_object_attributes",
           "get_object_lock_status", "get_object_acl", "get_object_tagging", "test_conditional_get", "test_range_get",
           "test_credentials", "query_account_profile")


def test_the_registered_set():
    by_group: dict[str, set[str]] = {}
    for td in registry.REGISTRY.values():
        by_group.setdefault(td.group, set()).add(td.name)
    assert by_group == NAMES
    assert len(registry.REGISTRY) == 30
    assert not set(RETIRED) & set(registry.REGISTRY)
    tools = registry.build_sdk_tools(responses=False)
    assert {t.name for t in tools} == set(registry.REGISTRY)


def test_mcp_never_exposes_the_estate_memory_or_the_conclusion():
    names = mcp.exposed()
    assert "note" not in names and "record_conclusion" not in names
    assert {"inspect_object", "test_object_read", "review_bucket_config", "query_estate"} <= names


@pytest.fixture()
def pid(client):
    return client.post("/providers/clouds", json={
        "name": "v8", "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
        "region": "us-east-1", "addressing_style": "path", "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "allowed_buckets": ["b"]}).json()["id"]


def _call(name, args):
    return registry.call_direct(name, args, actor="mcp", allowed=frozenset(registry.REGISTRY))


def _fake_reviews(monkeypatch, calls):
    for aspect, fn in config_tools._ASPECTS.items():
        def fake(conn, provider_id, bucket, _aspect=aspect):
            calls.append(_aspect)
            return {"success": True, "status": _aspect,
                    "findings": [{"category": "warning", "title": f"{_aspect} finding"}]}
        monkeypatch.setattr(ct, fn, fake)


def test_review_runs_only_the_aspects_asked_and_the_estate_sees_only_those(pid, monkeypatch):
    calls: list[str] = []
    ingested: list[dict] = []
    _fake_reviews(monkeypatch, calls)
    monkeypatch.setattr(config_tools.estate, "ingest_review",
                        lambda conn, p, b, outputs, **kw: ingested.append(outputs) or [])

    out = _call("review_bucket_config", {"provider_id": pid, "bucket": "b", "aspects": ["security"]})
    assert calls == ["security"] and out["aspects"] == ["security"]
    assert list(out["sections"]) == ["security"] and out["findings"][0]["section"] == "security"
    assert [list(o) for o in ingested] == [["security"]]

    calls.clear()
    ingested.clear()
    out = _call("review_bucket_config", {"provider_id": pid, "bucket": "b", "aspects": ["summary"]})
    assert calls == ["summary"] and ingested == []  # a summary decides nothing about issues

    calls.clear()
    ingested.clear()
    out = _call("review_bucket_config", {"provider_id": pid, "bucket": "b"})
    assert calls == ["summary", "security", "lifecycle", "observability", "cost"]  # the default is today's review
    assert [list(o) for o in ingested] == [["security"], ["lifecycle"]]
    assert len(out["findings"]) == 5

    calls.clear()
    assert "error" in _call("review_bucket_config", {"provider_id": pid, "bucket": "b", "aspects": ["bogus"]})
    assert calls == []
    assert "Refused" in _call("review_bucket_config", {"provider_id": pid, "bucket": "elsewhere"})["error"]


def test_a_single_unreadable_aspect_is_a_failed_call(pid, monkeypatch):
    monkeypatch.setattr(ct, "review_bucket_lifecycle",
                        lambda *a: {"success": False, "error_code": "AccessDenied"})
    monkeypatch.setattr(config_tools.estate, "ingest_review", lambda *a, **k: [])
    out = _call("review_bucket_config", {"provider_id": pid, "bucket": "b", "aspects": ["lifecycle"]})
    assert out["success"] is False and out["error_code"] == "AccessDenied"


def test_inspect_object_reads_head_by_default_and_each_aspect_on_request(pid, monkeypatch):
    seen: list[tuple] = []
    for fn in ("head_object", "get_object_attributes", "get_object_lock_status", "get_object_acl",
               "get_object_tagging"):
        monkeypatch.setattr(s3, fn, lambda conn, p, b, k, v, _fn=fn: seen.append((_fn, k, v)) or
                            {"success": True, "read": _fn})
    out = _call("inspect_object", {"provider_id": pid, "bucket": "b", "key": "k"})
    assert seen == [("head_object", "k", None)] and out == {"success": True, "read": "head_object"}

    seen.clear()
    out = _call("inspect_object", {"provider_id": pid, "bucket": "b", "key": "k", "version_id": "v1",
                                   "aspects": ["tags", "acl", "lock", "attributes"]})
    assert [s[0] for s in seen] == ["get_object_attributes", "get_object_lock_status", "get_object_acl",
                                    "get_object_tagging"]
    assert all(s[2] == "v1" for s in seen)
    assert out["success"] is True and out["acl"]["read"] == "get_object_acl" and out["key"] == "k"
    assert "error" in _call("inspect_object", {"provider_id": pid, "bucket": "b", "key": "k", "aspects": ["body"]})


def test_test_object_read_keeps_both_modes_and_the_range_budget(pid, monkeypatch):
    monkeypatch.setattr(s3, "test_conditional_get", lambda conn, p, b, k, etag: {"success": True, "etag": etag})
    monkeypatch.setattr(s3, "test_range_get", lambda conn, p, b, k, rng: {"success": True, "range": rng})
    assert _call("test_object_read", {"provider_id": pid, "bucket": "b", "key": "k", "mode": "conditional",
                                      "etag": '"abc"'})["etag"] == '"abc"'
    assert "error" in _call("test_object_read", {"provider_id": pid, "bucket": "b", "key": "k", "mode": "conditional"})
    assert "error" in _call("test_object_read", {"provider_id": pid, "bucket": "b", "key": "k", "mode": "full"})

    # The range budget is per turn: 12 reads, then a refusal the model reads.
    turn = registry.TurnContext("t", "u", threading.Event(), registry._DetachedRecorder())
    td = registry.REGISTRY["test_object_read"]
    results = []
    for _ in range(13):
        call = registry.CallContext(turn, "c", td.name)
        token = registry._current.set(call)
        try:
            results.append(td.fn(provider_id=pid, bucket="b", key="k", mode="range"))
        finally:
            registry._current.reset(token)
            call.close()
    assert results[0] == {"success": True, "range": "bytes=0-1023"}
    assert all("range" in r for r in results[:12]) and "budget" in results[12]["error"]


def test_query_estate_answers_posture_from_the_latest_survey(pid, conn):
    from app.core import store as core_store
    none = _call("query_estate", {"provider_id": pid, "survey_filter": "public_buckets"})
    assert none["has_survey"] is False
    core_store.add_artifact(conn, kind="survey", title="s", provider_id=pid, payload={
        "success": True, "buckets": [{"bucket_name": "b", "publicly_exposed": True},
                                     {"bucket_name": "c", "publicly_exposed": False}]})
    out = _call("query_estate", {"provider_id": pid, "survey_filter": "public_buckets"})
    assert out["has_survey"] is True and "surveyed_at" in out
    assert "error" in _call("query_estate", {"provider_id": pid, "survey_filter": "nonsense"})
    # One storage account: it is the default. With several, the account must be named.
    assert _call("query_estate", {"survey_filter": "all"})["has_survey"] is True
    conn.execute("INSERT INTO cloud_providers (id, name, provider_type, created_at, updated_at) "
                 "SELECT 'other', 'other', provider_type, created_at, updated_at FROM cloud_providers WHERE id = ?", (pid,))
    conn.commit()
    assert "error" in _call("query_estate", {"survey_filter": "all"})
    plain = _call("query_estate", {"provider_id": pid})
    assert plain["success"] is True and "issues" in plain


def test_a_retired_tool_name_replays_as_a_past_call():
    items = [
        {"type": "user_message", "turn_id": "t1", "payload": {"text": "is it there?"}},
        {"type": "tool_call", "turn_id": "t1", "payload": {"call_id": "c1", "name": "head_object",
                                                           "args": {"bucket": "b", "key": "k"}}},
        {"type": "tool_output", "turn_id": "t1", "payload": {"call_id": "c1", "model_output": "{\"size\":1}"}},
        {"type": "agent_message", "turn_id": "t1", "id": "m1", "payload": {"text": "Yes."}},
    ]
    out = to_input(items)
    call = next(i for i in out if i.get("type") == "function_call")
    assert call["name"] == "head_object" and call["call_id"] == "c1"
    assert any(i.get("type") == "function_call_output" and i["output"] == "{\"size\":1}" for i in out)
