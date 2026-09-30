"""v9 — the Agent, slimmed so a small local model can do a first survey turn.

Pins: slim, non-strict tool schemas with real enums; the first request's size;
the model-window table (longest match) and the local 16k default; compaction
that counts the fixed prefix; one tool output bounded by a small window; the
single storage account as the default ``provider_id``; a conclusion without an
answer (and old conclusions that still carry one); ``survey_account`` loaded on
the Responses backend; estate Issue names in tool results; tool-row notes.
"""

from __future__ import annotations

import json
import time

import pytest

from app.agent import budget, runtime
from app.agent import tools as _tools  # noqa: F401
from app.agent.session import to_input
from app.agent.tools import account as account_tools
from app.agent.tools import config as config_tools
from app.agent.tools import registry
from app.s3 import config_tools as ct
from tests.fake_model import FakeModel, text_turn, tool_turn

# Measured before v9 (Chat Completions, one storage account, "Survey my storage
# account"): request 0 was 36 456 chars — tool schemas 29 361, instructions 6 666.
BASELINE_REQUEST_CHARS = 36_456


def _schemas() -> dict[str, dict]:
    return {name: registry.tool_schema(td)[1] for name, td in registry.REGISTRY.items()}


def _schema_keys(node, path=""):
    """Every (path, key) that is a JSON-schema keyword — property NAMES are not keywords."""
    if isinstance(node, list):
        for i, x in enumerate(node):
            yield from _schema_keys(x, f"{path}[{i}]")
    elif isinstance(node, dict):
        for k, v in node.items():
            yield path, k
            if k in ("properties", "$defs"):
                for name, sub in v.items():
                    yield from _schema_keys(sub, f"{path}.{k}.{name}")
            else:
                yield from _schema_keys(v, f"{path}.{k}")


def _use(client, fake: FakeModel, **extra) -> str:
    return client.post("/providers/models", json={"name": "fake", "kind": "openai-compatible",
                                                   "base_url": fake.base_url, "model": "fake-model",
                                                   **extra}).json()["id"]


def _account(client, name: str = "demo") -> str:
    return client.post("/providers/clouds", json={
        "name": name, "provider_type": "s3-compatible", "endpoint_url": "https://minio.example.com",
        "region": "us-east-1", "addressing_style": "path", "access_key": "AKIAIOSFODNN7EXAMPLE",
        "secret_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}).json()["id"]


def _settle(client, task_id: str, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = client.get(f"/tasks/{task_id}").json()
        if snap["state"] not in ("working", "queued"):
            return snap
        time.sleep(0.05)
    raise AssertionError(f"task still {snap['state']}")


# --- schemas ---------------------------------------------------------------------


def test_no_schema_carries_a_pydantic_title():
    for name, schema in _schemas().items():
        titles = [p for p, k in _schema_keys(schema) if k == "title"]
        assert titles == [], (name, titles)
    # A property that is CALLED title survives: a finding has one.
    finding = _schemas()["record_conclusion"]["$defs"]["Finding"]
    assert "title" in finding["properties"] and finding["required"] == ["title", "severity"]


def test_optional_arguments_stay_optional():
    s = _schemas()
    assert s["list_objects"]["required"] == ["bucket"]
    assert "required" not in s["list_buckets"] and "required" not in s["survey_account"]
    assert "required" not in s["record_conclusion"] and "required" not in s["query_estate"]
    assert s["inspect_object"]["required"] == ["bucket", "key"]
    for name, schema in s.items():
        assert "provider_id" not in schema.get("required", []), name
        assert "anyOf" not in json.dumps(schema), name  # Optional[X] is sent as X
    tools = registry.build_sdk_tools(responses=False)
    assert all(t.strict_json_schema is False for t in tools)


def test_fixed_choices_are_enums():
    s = _schemas()
    assert s["review_bucket_config"]["properties"]["aspects"]["items"]["enum"] == [
        "summary", "security", "lifecycle", "observability", "cost", "performance"]
    assert s["inspect_object"]["properties"]["aspects"]["items"]["enum"] == [
        "head", "attributes", "lock", "acl", "tags", "preview", "range", "conditional"]
    assert s["import_evidence"]["properties"]["source_type"]["enum"] == ["inventory", "access_log"]
    assert "public_buckets" in s["query_estate"]["properties"]["survey_filter"]["enum"]
    assert "fix_proposed" in s["query_estate"]["properties"]["status"]["enum"]
    assert "policy_status" in s["review_bucket_config"]["properties"]["detail"]["enum"]
    severity = s["record_conclusion"]["$defs"]["Finding"]["properties"]["severity"]
    assert severity["enum"] == ["high", "medium", "low", "info"] and "pattern" not in severity
    metric = s["analyze_uploaded_file"]["properties"]["metric"]
    assert {"count", "sum_bytes", "p95_latency_ms", "distinct_storage_classes"} <= set(metric["enum"])
    assert not {"total_size", "avg_size"} & set(metric["enum"])  # one vocabulary for logs and inventories
    assert "allowed_metrics" not in json.dumps(s["analyze_uploaded_file"])
    assert "storage_class" in s["analyze_uploaded_file"]["properties"]["group_by"]["items"]["enum"]


def test_descriptions_are_short_single_lines():
    for name, td in registry.REGISTRY.items():
        desc, params = registry.tool_schema(td)
        assert "\n" not in desc and len(desc) <= 320, (name, len(desc))
        for prop, sub in params.get("properties", {}).items():
            assert len(sub.get("description", "")) <= 160, (name, prop)


def test_the_first_survey_request_fits_a_small_window(client):
    _account(client)
    with FakeModel([text_turn("ok")]) as fake:
        _use(client, fake)
        tid = client.post("/tasks", json={"direction": "Survey my storage account"}).json()["task"]["id"]
        _settle(client, tid)
    req = fake.requests[0]
    size = len(json.dumps(req))
    tools = len(json.dumps(req["tools"]))
    system = len(req["messages"][0]["content"])
    # v9 measured 21 752 chars (tools 16 576, instructions 4 796); v10 cut the
    # tool set to 15 (tools ≈ 10.9k as sent). Held at half of the v8 request.
    assert size <= BASELINE_REQUEST_CHARS * 0.5, (size, tools, system)
    assert tools <= 11_500 and system <= 5_200, (tools, system)
    assert len(req["tools"]) == len(registry.REGISTRY)


# --- windows ---------------------------------------------------------------------------


@pytest.mark.parametrize("model, window", [
    ("codellama:13b", 16_384), ("codellama-34b-instruct", 16_384),
    ("gemma3:12b", 128_000), ("gemma-3-27b-it", 128_000), ("gemma2:9b", 8_192), ("gemma:7b", 8_192),
    ("mistral-nemo:12b", 128_000), ("mistral:7b", 32_768), ("mixtral-8x7b", 32_768),
    ("qwen3:8b", 32_768), ("qwen2.5:14b", 128_000), ("qwen-max", 32_768),
    ("llama3.1:8b", 128_000), ("meta-llama/Llama-3.3-70B", 128_000), ("llama2:7b", 4_096),
    ("phi4:14b", 16_384), ("phi-3-mini-128k", 128_000),
    ("gpt-4o-mini", 128_000), ("gpt-4.1", 1_000_000), ("deepseek-chat", 128_000),
    ("some-unknown-model", 128_000),
])
def test_the_most_specific_window_entry_wins(model, window):
    assert budget.context_window(model) == window
    assert budget.context_window(model, 50_000) == 50_000  # a declared window always wins


def test_a_local_endpoint_without_a_declared_window_plans_for_16k(client, conn):
    from app.providers import models as providers

    def creds(**body) -> dict:
        pid = client.post("/providers/models", json={"name": "m", **body}).json()["id"]
        client.post(f"/providers/models/{pid}/activate")
        return providers.credentials(conn)

    assert creds(kind="ollama", model="llama3.1:8b")["context_window"] == 16_384
    assert creds(kind="lmstudio", model="gemma3:12b")["context_window"] == 16_384
    assert creds(kind="openai-compatible", base_url="http://10.0.0.5:8000/v1",
                 model="qwen3:8b")["context_window"] == 16_384
    assert creds(kind="vllm", model="qwen3:8b", context_window=40_960)["context_window"] == 40_960
    # Hosted endpoints keep the table.
    assert creds(kind="deepseek", model="deepseek-chat", api_key="sk-x")["context_window"] == 128_000
    assert creds(kind="openai-compatible", base_url="https://api.openai.com/v1", model="gpt-4.1",
                 api_key="sk-x")["context_window"] == 1_000_000
    # The field stays what the user set (null): the window shows "derived".
    rows = client.get("/providers/models").json()
    assert rows[0]["context_window"] is None


def test_the_dead_budgets_are_gone():
    assert not hasattr(budget, "tool_output_char_budget") and not hasattr(budget, "turn_token_budget")


# --- compaction and tool-output bounds ------------------------------------------------


def test_compaction_counts_the_fixed_prefix():
    window = 16_384  # 65 536 chars; the threshold is 80 %
    assert not runtime.needs_compaction(30_000, 0, window)
    assert runtime.needs_compaction(30_000, 23_000, window)  # the same history, plus what every request carries
    assert not runtime.needs_compaction(30_000, 23_000, 128_000)


def test_a_small_window_compacts_what_history_alone_would_not(client):
    """Three long answers (~41k chars) are well under 80 % of a 16k window
    (52k chars) — but not once the instructions and tool definitions are counted."""
    long = "Bucket findings. " * 800  # ≈ 13 600 chars
    with FakeModel([text_turn(long), text_turn(long), text_turn(long), text_turn("Fourth.")],
                   compaction="- Earlier: three long answers.") as fake:
        _use(client, fake)  # openai-compatible on localhost: planned as 16k
        tid = client.post("/tasks", json={"direction": "Q1"}).json()["task"]["id"]
        _settle(client, tid)
        for q in ("Q2", "Q3", "Q4"):
            client.post(f"/tasks/{tid}/turns", json={"direction": q})
            _settle(client, tid)
    assert len(fake.compaction_requests) == 1
    last = json.dumps(fake.requests[-1]["messages"])
    assert "three long answers" in last and "Q1" not in last


def test_one_tool_output_is_bounded_by_a_small_window():
    assert runtime.tool_output_chars(16_384) == 16_384
    assert runtime.tool_output_chars(128_000) == 60_000  # the absolute cap holds
    assert runtime.tool_output_chars(2_048) == 4_000


# --- the single storage account ----------------------------------------------------------


def test_the_only_account_is_the_default_provider(client, monkeypatch):
    from app.s3 import tools as s3
    monkeypatch.setattr(s3, "list_buckets", lambda conn, p: {"success": True, "provider_id": p, "buckets": []})
    pid = _account(client)
    td = registry.REGISTRY["list_buckets"]
    assert registry.with_default_provider(td, {}) == {"provider_id": pid}
    assert registry.with_default_provider(registry.REGISTRY["note"], {}) == {}  # an estate-wide note stays so
    with FakeModel([tool_turn("list_buckets", {}), text_turn("No buckets.")]) as fake:
        _use(client, fake)
        tid = client.post("/tasks", json={"direction": "What changed?"}).json()["task"]["id"]
        snap = _settle(client, tid)
    call = next(i for i in snap["items"] if i["type"] == "tool_call")
    out = next(i for i in snap["items"] if i["type"] == "tool_output")
    assert call["payload"]["args"]["provider_id"] == pid and call["payload"]["target"] == "demo"
    assert out["payload"]["ok"] is True and pid in out["payload"]["detail"]

    _account(client, "second")
    assert registry.with_default_provider(td, {}) == {}
    assert "Several storage accounts" in registry.scope_denial(td, {})
    refused = registry.call_direct("list_buckets", {}, actor="mcp",
                                   allowed=frozenset(registry.REGISTRY))
    assert "Several storage accounts" in refused["error"]


def test_the_prompt_names_accounts_not_ids(client, conn):
    from app.agent import prompt
    from app.estate import store as estate

    pid = _account(client, "prod")
    estate.ingest_survey(conn, pid, {"buckets": [{"bucket_name": "www", "publicly_exposed": True}]})
    text = prompt.dynamic_context(conn)
    digest = text[text.index("estate_digest: "):].split("<<end_external_untrusted_data>>")[0]
    assert "www" in digest and "Bucket is publicly accessible" in digest and pid not in digest
    assert "provider_id may be omitted" in text
    assert "chain-of-thought" not in prompt.INSTRUCTIONS
    # The two meta skills are gone; their routing lives in the instructions (v10: a table).
    assert "triage" not in text.split("skills (")[1].split("\n\n")[0]
    assert "Where to start:" in prompt.INSTRUCTIONS and "triage_error" in prompt.INSTRUCTIONS


def test_a_skill_loads_by_its_short_catalog_name():
    from app.skills import context as skills

    assert skills.read_skill_text("security-iam-policy") == skills.read_skill_text("storageops-security-iam-policy")
    assert "storageops-triage" not in skills.skill_names()
    assert "storageops-workbench-investigation" not in skills.skill_names()


# --- the conclusion -----------------------------------------------------------------------


def test_a_conclusion_is_findings_and_or_next_steps(client):
    with FakeModel([tool_turn("record_conclusion", {"next_steps": ["Review bucket www"]}),
                    tool_turn("record_conclusion", {}),
                    text_turn("Done.")]) as fake:
        _use(client, fake)
        tid = client.post("/tasks", json={"direction": "Check"}).json()["task"]["id"]
        snap = _settle(client, tid)
    concl = [i["payload"] for i in snap["items"] if i["type"] == "conclusion"]
    assert concl == [{"call_id": concl[0]["call_id"], "findings": [], "next_steps": ["Review bucket www"]}]
    outputs = [m for m in fake.requests[2]["messages"] if m.get("role") == "tool"]
    assert outputs[0]["content"] == "Conclusion recorded." and outputs[1]["content"].startswith("Not recorded")


def test_an_old_conclusion_with_an_answer_still_replays_and_reports(conn):
    from app.core import store
    from app.reports import report

    task = store.create_task(conn, "Old task")
    turn = store.create_turn(conn, task["id"], "Is it public?", status="completed")
    store.append_item(conn, task["id"], turn["id"], "user_message", {"text": "Is it public?"})
    store.append_item(conn, task["id"], turn["id"], "conclusion", {
        "call_id": "c-old", "answer": "Yes: www is public.",
        "findings": [{"title": "Bucket is publicly accessible", "severity": "high"}], "next_steps": ["Fix it"]})
    store.append_item(conn, task["id"], turn["id"], "agent_message", {"text": "www is public."})
    items = store.items_for_turns(conn, [turn["id"]])
    call = next(i for i in to_input(items) if i.get("type") == "function_call")
    assert call["name"] == "record_conclusion"
    assert json.loads(call["arguments"]) == {"findings": [{"title": "Bucket is publicly accessible",
                                                           "severity": "high"}], "next_steps": ["Fix it"]}
    md = report.render(conn, task["id"])
    assert "## Conclusion" in md and "Yes: www is public." in md and "**HIGH** — Bucket is publicly accessible" in md


# --- the Responses backend -------------------------------------------------------------------


def test_survey_account_is_always_loaded_on_responses():
    tools = registry.build_sdk_tools(responses=True)
    top = {getattr(t, "name", None): t for t in tools}
    assert "survey_account" in top and top["survey_account"].defer_loading is False
    assert "analyze_uploaded_file" in top and top["analyze_uploaded_file"].defer_loading is False
    assert any(getattr(t, "defer_loading", False) for t in tools)  # the rest still load on demand
    assert registry.schema_chars(responses=True) < registry.schema_chars(responses=False)


# --- estate Issue names in tool results ------------------------------------------------------


def test_a_review_finding_carries_the_estate_issue_name(client, monkeypatch):
    pid = _account(client)
    monkeypatch.setattr(ct, "review_bucket_security", lambda conn, p, b: {"success": True, "findings": [
        {"category": "critical", "title": "Anonymous s3:GetObject allowed"},
        {"category": "good", "title": "Default encryption enabled"}]})
    out = registry.call_direct("review_bucket_config", {"bucket": "www", "aspects": ["security"]},
                               actor="mcp", allowed=frozenset(registry.REGISTRY))
    public = out["findings"][0]
    assert public["issue"] == {"title": "Bucket is publicly accessible", "severity": "high"}
    assert "issue" not in out["findings"][1]
    assert config_tools._review_summary(out) == "1 issue"
    assert pid


def test_a_survey_row_names_its_issues():
    profile = {"success": True, "processed": 2, "summary": {"public_bucket_count": 1},
               "buckets": [{"bucket_name": "www", "access_status": "available", "publicly_exposed": True,
                            "encryption_status": "not_configured"},
                           {"bucket_name": "logs", "access_status": "available", "publicly_exposed": False,
                            "encryption_status": "available"}]}
    out = account_tools._compact(profile, "en")
    assert set(out["buckets"][0]["issues"]) == {"public_exposure", "no_default_encryption"}
    assert "issues" not in out["buckets"][1]
    assert out["issues"]["public_exposure"] == {"title": "Bucket is publicly accessible", "severity": "high"}
    assert account_tools._survey_summary(out) == "2 buckets, all readable; 1 public"


# --- tool-row notes ---------------------------------------------------------------------------


def test_tool_row_notes_read_as_short_plain_clauses():
    assert registry.tidy_summary("3 bucket(s) visible, 3 surveyed. Access: 3 available.") == \
        "3 buckets visible, 3 surveyed. Access: 3 available"
    assert registry.tidy_summary("12 bucket(s) visible, 12 surveyed. Access: 10 available, 2 access_denied. "
                                 "Public exposure UNDETERMINED for 2 bucket(s)") == "12 buckets visible, 12 surveyed"
    assert registry.tidy_summary("1 bucket(s) visible") == "1 bucket visible"
    assert len(registry.tidy_summary("x" * 200)) <= registry.SUMMARY_CHARS
    samples = {
        "survey_account": {"success": True, "processed": 3, "summary": {},
                           "buckets": [{"access_status": "available"}] * 3},
        "review_bucket_config": {"success": True, "findings": [{"category": "warning", "title": "a"}] * 19},
        "list_objects": {"success": True, "key_count": 12, "next_token": "t"},
        "list_buckets": {"success": True, "buckets": [{"name": "a"}]},
        "import_evidence": {"success": True, "files": 4, "coverage": "partial"},
        "analyze_uploaded_file": {"success": True, "rows": 1, "findings": [1, 2]},
        "triage_error": {"error_code": "AccessDenied", "candidate_causes": [1]},
        "probe_endpoint": {"check": "latency", "success": True, "p50_ms": 12.5, "p95_ms": 40.1},
        "inspect_object": {"success": True, "partial": True, "failed": ["acl"], "head": {"success": True}},
        "query_estate": {"success": True, "bucket_count": 1, "issues": [1, 2]},
    }
    notes = {}
    for name, result in samples.items():
        td = registry.REGISTRY[name]
        notes[name] = registry.tidy_summary((td.summarize or registry.default_summary)(result))
    assert notes["survey_account"] == "3 buckets, all readable; none public"
    assert notes["review_bucket_config"] == "19 warnings"
    assert notes["list_objects"] == "12 keys, more to page"
    assert notes["list_buckets"] == "1 bucket"
    assert notes["import_evidence"] == "imported 4 files, partial"
    assert notes["triage_error"] == "AccessDenied, 1 likely cause"
    assert notes["probe_endpoint"] == "p50 12.5 ms, p95 40.1 ms"
    assert notes["inspect_object"] == "partial: acl failed"
    for name, note in notes.items():
        assert "(s)" not in note and len(note) <= registry.SUMMARY_CHARS, (name, note)
