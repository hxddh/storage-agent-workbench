"""Tests for Phase 19 skills-only StorageOps context injection.

Skills are vendored SKILL.md + registry used as PROFESSIONAL METHOD context for
the existing Agent — no tools, scripts, CLI, runtime, API, DB, or RAG. These
verify loading, metadata-driven selection (no hard-coded error mapping, no
diagnosis output), the tools-disabled context wrapper, injection into both
agents, the minimal output contract, and that no forbidden surface is added.
"""

import json
import sqlite3
from pathlib import Path

import pytest

from app import config
from app.agent_runtime import session_agent
from app.error_triage import triage_agent
from app.skills import context as skill_context
from app.skills import contract as skill_contract
from app.skills import loader, selection

ACCESS = "AKIAIOSFODNN7EXAMPLE"
MODEL_KEY = "sk-MODELSECRETDONOTLEAK1234"
PACK = Path(__file__).resolve().parents[1] / "app" / "bundled_skillpacks" / "storageops"


def _db():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


def _session(client, **kw):
    return client.post("/sessions", json={"title": "S", "goal": "diagnose", **kw}).json()


def _add_model_provider(client):
    client.post("/model-providers", json={
        "name": "openai", "provider_type": "openai", "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini", "api_key": MODEL_KEY})


# --- vendored pack ----------------------------------------------------------


def test_registry_and_skill_md_load():
    skills = loader.load_registry()
    assert len(skills) >= 10
    names = {s.name for s in skills}
    assert "storageops-triage" in names
    # every registry skill resolves to a readable SKILL.md
    for s in skills:
        body = loader.load_skill_body(s.name)
        assert body and body.strip()


def test_no_references_templates_scripts_vendored():
    # Only skill-registry.yaml + skills/*/SKILL.md should exist in the pack.
    for sub in ("references", "templates", "scripts", "storageops_cli", "extensions", "_vendor"):
        assert not list(PACK.rglob(sub)), f"unexpected vendored dir: {sub}"
    non_md = [p for p in PACK.rglob("*") if p.is_file()
              and p.name != "SKILL.md" and p.name != "skill-registry.yaml"]
    assert non_md == [], f"unexpected vendored files: {non_md}"


def test_skills_are_app_native_no_foreign_runtime():
    """SKILL.md bodies + registry must be app-native: no references to a foreign
    runtime (Pi tools, helper scripts, references/ files, the old output
    contract). They should speak in terms of THIS app's read-only tools and
    confirmed runs."""
    from app.skills import loader

    forbidden = [
        "scan_secrets", "detect_domain", "search_memory", "capture_http_trace",
        "recommended_tools", "estimated_tokens", "python3 scripts/", "scripts/",
        "references/", "Pi runtime", "light_heavy", "root_cause_type",
    ]
    registry = (PACK / "skill-registry.yaml").read_text(encoding="utf-8")
    skills = loader.load_registry()
    assert len(skills) >= 16
    for token in forbidden:
        assert token not in registry, f"foreign token in registry: {token}"
    # At least one real app tool name appears across the bodies (they reference
    # the agent's actual read-only surface, not a foreign one).
    corpus = "\n".join(loader.load_skill_body(m.name) or "" for m in skills)
    for token in forbidden:
        assert token not in corpus, f"foreign token in a SKILL.md body: {token}"
    for app_tool in ("test_credentials", "read_skill", "review_bucket_"):
        assert app_tool in corpus, f"expected app tool referenced in skills: {app_tool}"


def test_recommended_tools_not_in_metadata_or_context():
    # loader must not expose recommended_tools, and skill context must not inject them.
    for s in loader.load_registry():
        assert not hasattr(s, "recommended_tools")


def test_skill_context_strips_frontmatter_for_offline_triage():
    # SKILL.md begins with a YAML frontmatter; none of it may reach the prompt.
    raw = loader.load_skill_body("storageops-triage")
    assert raw.lstrip().startswith("---")  # frontmatter block exists in source

    ctx = skill_context.build_skill_context("object storage S3 error triage 403 AccessDenied SlowDown")
    text = ctx["text"]
    assert "recommended_tools" not in text           # frontmatter key gone
    assert "---\nname:" not in text                  # frontmatter block gone
    assert "estimated_tokens" not in text            # another frontmatter-only key
    # Offline-triage wrapper frames skills as method guidance (no live tools),
    # without the old self-contradictory "tools disabled" language.
    assert "professional diagnostic method" in text
    assert "=== StorageOps skill:" in text


def test_strip_frontmatter_helper():
    sample = "---\nname: x\nrecommended_tools:\n  - scan_secrets\n---\n# Body\nhello"
    out = skill_context.strip_frontmatter(sample)
    assert out.startswith("# Body")
    assert "recommended_tools" not in out and "scan_secrets" not in out
    # a body without frontmatter is unchanged
    assert skill_context.strip_frontmatter("# No frontmatter\nx") == "# No frontmatter\nx"


# --- selection --------------------------------------------------------------


def test_selector_returns_candidates_from_metadata():
    cands = selection.candidate_dicts("403 AccessDenied bucket policy IAM permission")
    assert 1 <= len(cands) <= selection.MAX_CANDIDATES
    assert all(set(c.keys()) == {"name", "match_reason", "selection_basis"} for c in cands)


def test_selector_output_has_no_diagnosis_fields():
    cands = selection.candidate_dicts("SignatureDoesNotMatch region endpoint")
    for c in cands:
        for forbidden in ("diagnosis", "root_cause", "remediation", "confidence",
                          "score", "next_check", "fix"):
            assert forbidden not in c


def test_selector_fallback_is_metadata_auto_route():
    cands = selection.candidate_dicts("zzzznomatchatall qwerty")
    # Falls back to the registry auto_route skill, not a hard-coded mapping.
    assert cands and cands[0]["selection_basis"] == "auto_route_fallback"


# --- context wrapper --------------------------------------------------------


def test_offline_triage_skill_context_is_method_guidance():
    ctx = skill_context.build_skill_context("429 SlowDown throttling performance")
    assert ctx["skills"]
    assert "professional diagnostic method" in ctx["text"]
    assert len(ctx["text"]) <= skill_context.MAX_TOTAL_CHARS + 2000  # bounded
    assert len(ctx["skills"]) <= skill_context.MAX_SKILLS


def test_session_agent_uses_progressive_disclosure_catalog():
    # The live agent gets a CATALOG (name + description for every skill) and a
    # read_skill tool — not pre-injected full bodies (the Agent Skills paradigm).
    cat = skill_context.catalog_text()
    assert "STORAGEOPS SKILLS" in cat and "read_skill(" in cat
    names = skill_context.skill_names()
    assert "storageops-triage" in names and len(names) >= 10
    for n in names:  # every catalogued skill loads on demand
        assert skill_context.read_skill_text(n)
    assert skill_context.read_skill_text("does-not-exist") is None


def test_read_skill_is_a_readonly_session_tool():
    import sqlite3
    from app.agent_runtime import session_tools, guardrails

    def fake_function_tool(fn):
        fn.name = fn.__name__
        return fn

    conn = sqlite3.connect(":memory:")
    try:
        tools = session_tools.build(conn, fake_function_tool, [])
    finally:
        conn.close()
    names = {getattr(t, "name", "") for t in tools}
    assert "read_skill" in names
    assert not guardrails.is_forbidden_tool("read_skill")


# --- contract parser --------------------------------------------------------


def test_agent_contract_minimal_shape_and_coercion():
    raw = (
        "Region mismatch is most likely. <thinking>secret</thinking>\n"
        "```json\n"
        '{"answer": "Region mismatch is most likely.", "skills_used": ["storageops-s3-protocol-compatibility", "made-up-skill"],'
        ' "evidence_used": ["triage parsed signals"], "evidence_gaps": ["client region config"],'
        ' "next_action_proposals": [{"title": "Run a diagnostic", "action_type": "run_diagnostic"},'
        ' {"title": "rm -rf", "action_type": "exec_shell_wipe"}]}\n```'
    )
    out = skill_contract.parse_agent_contract(raw, allowed_skill_names=["storageops-s3-protocol-compatibility"])
    assert set(out) == {"answer", "skills_used", "evidence_used", "evidence_gaps", "next_action_proposals"}
    assert "secret" not in out["answer"]  # CoT stripped
    assert out["skills_used"] == ["storageops-s3-protocol-compatibility"]  # unknown dropped
    assert len(out["next_action_proposals"]) == 1  # forbidden-token action_type dropped
    assert out["next_action_proposals"][0]["requires_confirmation"] is True


# --- session assistant injection --------------------------------------------


def test_session_assistant_prompt_includes_skill_context(client, monkeypatch):
    s = _session(client, goal="getting 403 AccessDenied on bucket policy")
    _add_model_provider(client)
    captured = {}

    def fake_loop(spec):
        captured["spec"] = spec
        return "Here is guidance.\n```json\n{\"answer\": \"Here is guidance.\", \"skills_used\": [], \"evidence_gaps\": [\"need the policy\"]}\n```"

    monkeypatch.setattr(session_agent, "SESSION_LOOP", fake_loop)
    out = client.post(f"/sessions/{s['id']}/messages", json={"content": "why 403 AccessDenied?"}).json()
    prompt = captured["spec"]["prompt"]
    # Progressive disclosure: the prompt carries the skills CATALOG + read_skill,
    # not pre-injected full skill bodies.
    assert "STORAGEOPS SKILLS" in prompt and "read_skill(" in prompt
    # contract surfaced in response
    assert "skills_used" in out and "evidence_gaps" in out
    assert out["evidence_gaps"] == ["need the policy"]


def test_triage_agent_prompt_includes_skill_context(client, monkeypatch):
    s = _session(client)
    _add_model_provider(client)
    captured = {}

    def fake_loop(spec):
        captured["spec"] = spec
        return "Likely a signature/region issue."

    monkeypatch.setattr(triage_agent, "TRIAGE_LOOP", fake_loop)
    body = {"content": "<Error><Code>SignatureDoesNotMatch</Code></Error> region us-east-1",
            "input_kind": "error_code", "session_id": s["id"], "planner_mode": "agent"}
    out = client.post("/error-triage", json=body).json()
    prompt = captured["spec"]["prompt"]
    # Offline triage injects a selected skill body as method guidance.
    assert "StorageOps skill" in prompt
    assert "professional diagnostic method" in prompt
    assert out["agent_interpretation"]
    assert "skills_offered" in out


def test_deterministic_triage_does_not_claim_skill_diagnosis(client):
    s = _session(client)
    out = client.post("/error-triage", json={
        "content": "<Error><Code>AccessDenied</Code></Error>", "input_kind": "error_code",
        "session_id": s["id"]}).json()  # deterministic default
    assert out["planner_mode"] == "deterministic"
    assert out["agent_interpretation"] is None
    assert out["skills_used"] == []  # no skill-grounded diagnosis without an Agent run


# --- guardrails: no forbidden surface in executable code --------------------


def _read_py(root: Path, exclude=("bundled_skillpacks",)) -> str:
    return "\n".join(
        p.read_text() for p in root.rglob("*.py")
        if not any(x in str(p) for x in exclude)
    )


def test_no_storageops_tooling_in_executable_code():
    app_dir = Path(__file__).resolve().parents[1] / "app"
    src = _read_py(app_dir)
    # Genuine execution / import / tool-call patterns must not exist in .py code.
    # (The same words may appear in bundled SKILL.md prose, which is excluded.)
    for forbidden in (
        "import subprocess", "subprocess.", "shell=True", "os.system", "os.popen",
        "import storageops_cli", "storageops_cli.", "httpmon",
        "capture_http_trace(", "scan_secrets(", "detect_domain(", "search_memory(",
        "import pi_runtime", "from agents import handoff",
    ):
        assert forbidden not in src, f"forbidden in executable code: {forbidden}"


def test_migrations_are_sequential_and_capped():
    from app import migrations
    # Migration 15 adds runs.origin (agent-initiated runs hidden from the thread).
    versions = [v for v, _n, _s in migrations.MIGRATIONS]
    assert versions == list(range(1, len(versions) + 1))  # 1..N, no gaps/dupes
    assert max(versions) == 15


def test_no_public_skills_api(client):
    assert client.get("/skills").status_code == 404
    assert client.get("/skills/storageops-triage").status_code == 404
    assert client.post("/sessions/x/skill-context", json={}).status_code in (404, 405)


def test_loader_resolves_via_app_package_path():
    # The loader resolves the pack relative to the `app` package, which is what
    # PyInstaller extracts (Fix B). pack_root must sit under .../app/.
    root = loader.pack_root()
    assert root.name == "storageops" and root.parent.name == "bundled_skillpacks"
    assert root.parent.parent.name == "app"
    assert (root / "skill-registry.yaml").is_file()
    assert loader.load_skill_body("storageops-triage")


def test_pyinstaller_spec_bundles_skillpack():
    # Fix B: the one-file spec must ship app/bundled_skillpacks as data.
    spec = (Path(__file__).resolve().parents[1] / "packaging" / "storage-agent-sidecar.spec").read_text()
    assert "bundled_skillpacks" in spec
    assert '"app/bundled_skillpacks"' in spec
