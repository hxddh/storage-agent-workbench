"""The tool set: fewer, broader tools with no capability lost (v8: 30; v10: 15).

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
    "core": {"read_skill", "query_estate", "fix_preview", "note", "record_conclusion", "list_buckets"},
    "probes": {"probe_endpoint"},
    "objects": {"list_objects", "inspect_object"},
    "config": {"review_bucket_config"},
    "account": {"survey_account"},
    "files": {"analyze_uploaded_file", "import_evidence"},
    "advice": {"triage_error", "simulate_storage_cost"},
}
RETIRED = ("get_bucket_config_summary", "review_bucket_security", "review_bucket_lifecycle",
           "review_bucket_observability", "review_bucket_cost_optimization", "head_object", "get_object_attributes",
           "get_object_lock_status", "get_object_acl", "get_object_tagging", "test_conditional_get", "test_range_get",
           "test_credentials", "query_account_profile",
           # v10
           "head_bucket", "get_bucket_location", "test_addressing_style", "inspect_endpoint_tls",
           "measure_request_latency", "diagnose_presigned_url", "list_object_versions", "list_multipart_uploads",
           "list_upload_parts", "test_object_read", "preview_object", "get_bucket_config_detail",
           "review_bucket_performance_profile", "list_uploaded_files", "aggregate_uploaded_file",
           "compare_to_last_survey")


def test_the_registered_set():
    by_group: dict[str, set[str]] = {}
    for td in registry.REGISTRY.values():
        by_group.setdefault(td.group, set()).add(td.name)
    assert by_group == NAMES
    assert len(registry.REGISTRY) == 15
    assert not set(RETIRED) & set(registry.REGISTRY)
    tools = registry.build_sdk_tools(responses=False)
    assert {t.name for t in tools} == set(registry.REGISTRY)


def test_mcp_never_exposes_the_estate_memory_or_the_conclusion():
    names = mcp.exposed()
    assert "note" not in names and "record_conclusion" not in names
    assert {"inspect_object", "probe_endpoint", "list_objects", "review_bucket_config", "query_estate"} <= names


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
    assert calls == ["summary", "security", "lifecycle", "observability", "cost"]  # performance only on request
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
    assert "partial" not in out
    assert "error" in _call("inspect_object", {"provider_id": pid, "bucket": "b", "key": "k", "aspects": ["body"]})
    # A string where the list belongs is one aspect, not a TypeError.
    seen.clear()
    assert _call("inspect_object", {"provider_id": pid, "bucket": "b", "key": "k", "aspects": "acl"})["read"] == \
        "get_object_acl"


def test_an_unreadable_acl_makes_inspect_object_partial(pid, monkeypatch):
    monkeypatch.setattr(s3, "head_object", lambda *a: {"success": True, "size": 3, "request_id": "R1",
                                                      "headers_sanitized": {"server": "x", "date": "d",
                                                                            "x-amz-bucket-region": "eu"}})
    monkeypatch.setattr(s3, "get_object_acl", lambda *a: {"success": False, "error_code": "AccessDenied",
                                                          "request_id": "R2", "host_id": "H"})
    out = _call("inspect_object", {"provider_id": pid, "bucket": "b", "key": "k", "aspects": ["head", "acl"]})
    assert out["partial"] is True and out["failed"] == ["acl"]
    # Noise is gone: no host id, no request id on a success, no routing headers.
    assert out["head"] == {"success": True, "size": 3, "headers_sanitized": {"x-amz-bucket-region": "eu"}}
    assert out["acl"] == {"success": False, "error_code": "AccessDenied", "request_id": "R2"}
    only = _call("inspect_object", {"provider_id": pid, "bucket": "b", "key": "k", "aspects": ["acl"]})
    assert only["success"] is False


def _run(turn, name, **kwargs):
    call = registry.CallContext(turn, "c", name)
    token = registry._current.set(call)
    try:
        return registry.REGISTRY[name].fn(**kwargs)
    finally:
        registry._current.reset(token)
        call.close()


def test_inspect_object_reads_keep_their_modes_and_per_turn_budgets(pid, monkeypatch):
    monkeypatch.setattr(s3, "test_conditional_get", lambda conn, p, b, k, etag: {"success": True, "etag": etag})
    monkeypatch.setattr(s3, "test_range_get", lambda conn, p, b, k, rng: {"success": True, "range": rng})
    monkeypatch.setattr(s3, "preview_object", lambda conn, p, b, k, n: {"success": True, "bytes_read": n})
    assert _call("inspect_object", {"provider_id": pid, "bucket": "b", "key": "k", "aspects": ["conditional"],
                                    "etag": '"abc"'})["etag"] == '"abc"'
    assert "error" in _call("inspect_object", {"provider_id": pid, "bucket": "b", "key": "k",
                                               "aspects": ["conditional"]})

    # The range budget is per turn: 12 reads, then a refusal the model reads.
    turn = registry.TurnContext("t", "u", threading.Event(), registry._DetachedRecorder())
    results = [_run(turn, "inspect_object", provider_id=pid, bucket="b", key="k", aspects=["range"])
               for _ in range(13)]
    assert results[0] == {"success": True, "range": "bytes=0-1023"}
    assert all("range" in r for r in results[:12]) and "budget" in results[12]["error"]

    # Previews: 16 objects and 24 MiB per turn; each read is clamped to what is left.
    turn = registry.TurnContext("t", "u", threading.Event(), registry._DetachedRecorder())
    sizes = [_run(turn, "inspect_object", provider_id=pid, bucket="b", key="k", aspects=["preview"],
                  preview_kib=1024).get("bytes_read") for _ in range(25)]
    assert sizes[:16] == [1024 * 1024] * 16 and sizes[16] is None


def test_probe_endpoint_picks_its_engine_read_and_keeps_the_latency_budget(pid, monkeypatch):
    seen = []
    monkeypatch.setattr(s3, "head_bucket", lambda c, p, b: seen.append("reach") or {"success": True})
    monkeypatch.setattr(s3, "get_bucket_location", lambda c, p, b: seen.append("location") or {"success": True})
    monkeypatch.setattr(s3, "test_path_style_vs_virtual_host",
                        lambda c, p, b: seen.append("addressing") or {"recommendation": "path"})
    monkeypatch.setattr(s3, "inspect_tls", lambda url: seen.append("tls") or {"tls_version": "TLSv1.3"})
    monkeypatch.setattr(s3, "measure_request_latency",
                        lambda c, p, b, k, n: seen.append(("latency", k, n)) or {"success": True, "p50_ms": 1})
    for check in ("reach", "location", "addressing", "tls"):
        assert _call("probe_endpoint", {"provider_id": pid, "bucket": "b", "check": check})["check"] == check
    assert _call("probe_endpoint", {"provider_id": pid, "bucket": "b", "check": "latency", "key": "k",
                                    "samples": 99})["p50_ms"] == 1
    assert seen == ["reach", "location", "addressing", "tls", ("latency", "k", 10)]
    assert "error" in _call("probe_endpoint", {"provider_id": pid, "check": "reach"})  # needs a bucket
    assert _call("probe_endpoint", {"provider_id": pid, "check": "tls"})["check"] == "tls"  # does not
    assert "Refused" in _call("probe_endpoint", {"provider_id": pid, "bucket": "elsewhere"})["error"]
    turn = registry.TurnContext("t", "u", threading.Event(), registry._DetachedRecorder())
    runs = [_run(turn, "probe_endpoint", provider_id=pid, bucket="b", check="latency") for _ in range(9)]
    assert all(r.get("success") for r in runs[:8]) and "budget" in runs[8]["error"]


def test_list_objects_kinds_page_with_one_token(pid, monkeypatch):
    calls = []
    monkeypatch.setattr(s3, "list_object_versions", lambda c, p, b, pre, n, key_marker, version_id_marker: calls.append(
        (key_marker, version_id_marker)) or {"success": True, "version_count": 2, "sample_keys": ["a"],
                                              "sample_versions": [{"key": "a"}], "next_key_marker": "a",
                                              "next_version_id_marker": "v2"})
    monkeypatch.setattr(s3, "list_multipart_uploads", lambda c, p, b, n, pre, key_marker, upload_id_marker: {
        "success": True, "upload_count": 1, "sample_keys": ["big"],
        "sample_uploads": [{"key": "big", "upload_id": "U1"}], "next_key_marker": None,
        "next_upload_id_marker": None})
    first = _call("list_objects", {"provider_id": pid, "bucket": "b", "kind": "versions"})
    assert "sample_keys" not in first and first["next_token"]
    _call("list_objects", {"provider_id": pid, "bucket": "b", "kind": "versions", "page_token": first["next_token"]})
    assert calls == [(None, None), ("a", "v2")]
    up = _call("list_objects", {"provider_id": pid, "bucket": "b", "kind": "uploads"})
    assert up["sample_uploads"][0]["upload_id"] == "U1" and up["next_token"] is None and "sample_keys" not in up


def test_query_estate_compares_the_two_latest_surveys(pid, conn):
    from app.core import store as core_store
    assert _call("query_estate", {"provider_id": pid, "since_last_survey": True})["comparable"] is False
    for public in (False, True):
        core_store.add_artifact(conn, kind="survey", title="s", provider_id=pid, payload={
            "success": True, "buckets": [{"bucket_name": "b", "publicly_exposed": public}]})
    out = _call("query_estate", {"since_last_survey": True})  # the only account
    assert out["comparable"] is True and "older_at" in out


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
