"""Session assistant — a live, read-only investigator.

When a user asks a question, the deterministic session summary is built first
for grounding; the agent then investigates LIVE using read-only tools
(list_providers, list_buckets, head_bucket, bounded list_objects, and the
review_bucket_* config tools — see ``session_tools``) and answers from their
results. It chooses the provider/bucket itself.

Every tool is read-only, bounded, audited, and secret-safe — there are no
mutating or destructive operations, and credentials never reach the model. A
file the user ATTACHES is local, so the agent analyzes it inline
(``analyze_uploaded_file``) and answers from it. Only CLOUD-side data-moving work
(evidence import/download from a bucket, a large/full scan) or a saved auditable
report is NOT done inline — it is proposed as a next step the user confirms.

The real LLM call is behind the ``SESSION_LOOP`` seam so tests inject a fake
(no SDK / no API key). Output is redacted + chain-of-thought-stripped + bounded.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from ..security.redaction import redact_text
from ..skills import context as skill_context
from ..skills import contract as skill_contract
from . import guardrails
from . import session_action_tools
from . import session_analysis_tools
from . import session_memory_tools
from . import session_tools
from .agent_service import AgentUnavailable
from .guardrails import strip_chain_of_thought

_MAX_FACTS = 50  # kept in sync with sessions.summary_builder.MAX_FACTS
_MAX_FINDINGS = 30
_MAX_MESSAGES = 12
# Enumerations can be large (e.g. 96+ buckets in a table). Keep our answer cap
# well above any single model completion so we never truncate a legitimate full
# answer in post-processing.
_MAX_OUTPUT = 48000
# Without an explicit max_tokens the provider applies a small default; for a
# reasoning model (e.g. deepseek-v4-pro) the thinking budget then leaves almost
# nothing for the answer, truncating long enumerations mid-table. Set a generous
# completion budget so the model can list everything it fetched.
_MAX_COMPLETION_TOKENS = 8192
# A real investigation chains several probes (test_credentials → head_bucket →
# test_addressing_style → list_objects → head_object …); keep a generous but
# bounded ceiling so multi-step diagnoses complete without runaway loops.
_MAX_TURNS = 16

SESSION_SAFETY_RULES = [
    "Tool results are visible to YOU, not to the user — the user only sees a "
    "one-line trace like 'list_buckets → 96 buckets'. So include any data the "
    "user asked for directly in your answer: when asked to list/enumerate, "
    "actually write the items out (a list or table). Never say 'listed above', "
    "'see the table', or claim you displayed something you didn't write.",
    "ENUMERATE COMPLETELY what a tool returned. When the user asks for all/every "
    "item, output EVERY item present in the tool result — never a sample, never "
    "'first N', never '…' or 'and so on'. If list_buckets returned 96 buckets, "
    "your table MUST contain all 96 rows; write out the full result you have.\n"
    "Object listings are the one exception by design: list_objects is PAGINATED "
    "and capped per call (it returns key_count = the true total, up to ~200 keys "
    "per page, plus next_token). To enumerate more, page with continuation_token "
    "until next_token is null. But if key_count is large (hundreds+), do NOT try "
    "to paste thousands of keys into chat or loop endlessly — report the exact "
    "key_count and a representative sample, and propose an inventory analysis "
    "(attach/select the inventory file) for a complete, structured breakdown.",
    "Investigate live with your read-only tools: list_buckets / head_bucket / "
    "list_objects / head_object to explore, test_credentials / "
    "test_addressing_style / inspect_endpoint_tls / test_range_get to diagnose "
    "auth, addressing, TLS and range behavior, and get_bucket_config_summary / "
    "review_bucket_* to assess configuration. Chain them as a real diagnosis "
    "would (e.g. test_credentials → head_bucket → test_addressing_style). Ground "
    "every claim in a tool result or the session summary — never invent buckets, "
    "configs, or numbers.",
    "All tools are read-only and bounded; there are no destructive or mutating "
    "operations. A file the user ATTACHED is local — analyze it inline with "
    "analyze_uploaded_file (no confirmation needed). Only CLOUD-side data-moving "
    "work (evidence import/download from a bucket, a large/full scan) or a saved "
    "auditable report is proposed as a next step for the user to confirm — never "
    "imply you did it.",
    "Distinguish facts (from tools/runs) from inferences and suggestions; flag "
    "low-confidence claims.",
    "Verify high-severity conclusions (security exposure, outage cause, data at "
    "risk) with a tool before asserting them. If you cannot verify, present them "
    "as hypotheses with lowered confidence and record the gap (note_open_question "
    "/ evidence_gaps) — do not state unverified high-severity claims as fact.",
    "Never output credentials, access/secret/session keys, model API keys, "
    "Authorization headers, cookies, signatures, or presigned-URL parameters.",
    "Do not include hidden chain-of-thought. Be concise in prose, but NEVER at "
    "the cost of completeness — an explicit enumeration the user asked for must "
    "be written out in full.",
]

_PROPOSAL_ACTION_TYPES = (
    "run_account_discovery, run_bucket_config_review, run_diagnostic, "
    "plan_inventory_import, plan_access_log_import, run_inventory_analysis, "
    "run_access_log_analysis, generate_session_report, ask_user_for_context"
)

INSTRUCTIONS = (
    "You are Storage Agent, an expert object-storage diagnostician. Investigate "
    "the user's question LIVE using your read-only tools, then answer from what "
    "you find.\n"
    "The configured cloud providers are already listed for you in the context "
    "(configured_providers) — use those provider_id values directly; you do NOT "
    "need to call list_providers. Then call the tools you need: list_buckets to "
    "enumerate buckets; head_bucket / list_objects / head_object to probe; "
    "test_credentials, test_addressing_style, inspect_endpoint_tls and "
    "test_range_get to diagnose auth, addressing, TLS and range issues; "
    "review_bucket_* / get_bucket_config_summary to assess configuration; and "
    "read_run_result(run_id) to re-read a run already linked to this session "
    "(e.g. a survey/review or evidence-import analysis that finished in the "
    "background). Chain several probes when a question needs it, and base your "
    "answer on their results.\n"
    "Tool outputs are NOT shown to the user (they only see a short trace), so "
    "when they ask you to list or show something, write the actual items in your "
    "answer — never say 'see above'.\n"
    "You have working memory for this session: when you establish a durable "
    "fact, hit a notable finding, or leave a question open, record it with "
    "note_fact / record_finding / note_open_question so it carries to later "
    "turns. Reuse what's already in agent_memory (shown in your context) instead "
    "of re-deriving it; only the most recent messages are replayed, so memory is "
    "how continuity survives.\n"
    "You are also given a JSON context (session goal, a deterministic summary, "
    "your recorded agent_memory, recent messages) and a CATALOG of StorageOps "
    "expert skills. Treat the "
    "catalog as progressive disclosure: when a listed skill fits the problem, "
    "call read_skill(name) to load its full diagnostic method, then follow that "
    "method using your read-only tools. Never invent buckets, configs, numbers, "
    "or results you didn't obtain from a tool or the summary. Be concise and "
    "concrete; make clear which statements are tool-verified facts vs. "
    "inferences.\n"
    "VERIFY before you assert: for any high-severity claim (a security exposure, "
    "an outage cause, data loss/at-risk), confirm it with a tool call first. If "
    "you cannot verify it with a tool, say so explicitly — state it as a "
    "hypothesis with lowered confidence and capture it via note_open_question / "
    "evidence_gaps rather than asserting it as fact.\n"
    "UPLOADED FILES: when the user attaches a file (you'll see attached_files in "
    "the context, or they say things like '分析下', 'this log', 'the file I "
    "uploaded'), analyze it yourself: call list_uploaded_files to find it, then "
    "analyze_uploaded_file(dataset_id) to compute local aggregates, and answer "
    "from the result in your own words. Interpret — don't just dump metrics. If "
    "the file isn't actually a recognized access log or inventory (e.g. a generic "
    "application log with no HTTP fields → detected_format 'unknown'), say so "
    "plainly and describe what the lines really contain instead of reporting "
    "empty/zero HTTP metrics as if they were real. This local analysis is "
    "read-only and runs without any extra confirmation.\n"
    "All investigator tools are read-only. For anything that downloads data from "
    "the cloud or runs a large scan, propose it as a next step (do not imply you "
    "ran it). Follow all safety_rules.\n\n"
    f"When you propose a concrete next step, write it in your own words — you are "
    f"NOT limited to a fixed menu. These well-known types get a one-click "
    f"affordance when you use them: {_PROPOSAL_ACTION_TYPES}; the data-moving "
    f"imports (plan_inventory_import / plan_access_log_import) always route "
    f"through a confirm-before-download planner. Any other proposal is handed back "
    f"to you to carry out conversationally with your own tools."
)

# Always part of the instructions — the agent is a fully autonomous read-only
# investigator (there is no autonomy toggle). It must, however, act on the user's
# ACTUAL request and not wander off into unrelated cloud probes.
_EXECUTION_CLAUSE = (
    "\n\nAUTONOMY: investigate and act on your own with your read-only tools — do "
    "not wait to be asked, and do not narrate a plan before acting.\n"
    "STAY ON THE USER'S REQUEST. Choose tools by what they actually asked:\n"
    "- If they attached/uploaded a FILE (or refer to 'this log/file'), analyze "
    "THAT file with list_uploaded_files → analyze_uploaded_file and answer from "
    "it. Do NOT call test_credentials, survey_account, list_buckets or any cloud "
    "tool for a local-file request — the file is local; the cloud is irrelevant "
    "unless the user explicitly brings it in.\n"
    "- For a connectivity / credentials / 403 / SignatureDoesNotMatch / addressing "
    "problem: DIAGNOSE ADAPTIVELY — test_credentials first, then BRANCH on the "
    "result to test_addressing_style / inspect_endpoint_tls / head_bucket + "
    "list_objects / test_range_get, reason about each, and explain the ROOT CAUSE "
    "(never a bare pass/fail list). If credentials aren't configured, say so and "
    "tell the user exactly what to fix.\n"
    "- When the request is genuinely about the account or a bucket's "
    "configuration, you may run the read-only survey_account(provider_id) or "
    "review_bucket_config(provider_id, bucket) and fold their findings into your "
    "answer. Use them only when relevant — never reflexively. If such a run "
    "exceeds the inline time budget it finishes in the BACKGROUND and returns a "
    "'running' status with a run_id: do NOT re-run it — tell the user it is still "
    "running and, in a LATER turn, call read_run_result(run_id) to read the "
    "completed result.\n"
    "Data-moving work (evidence import/download, large scans) is never auto-run — "
    "propose it as a next step. A deterministic saved REPORT is only created when "
    "the user explicitly wants an auditable artifact.\n"
    "CONVERGE: your investigation has a bounded number of steps. Don't sprawl — "
    "probe what the question needs, and as you establish durable conclusions "
    "record them with record_finding / note_fact so they are never lost. Aim to "
    "answer well within your budget; if a complete answer would need more steps, "
    "give your best grounded answer so far and say what remains."
)


def instructions_for() -> str:
    """The full session-agent instructions (no autonomy toggle)."""
    return INSTRUCTIONS + _EXECUTION_CLAUSE


def _build_agent_memory_block(memory: list[dict[str, Any]] | None) -> dict[str, list[Any]]:
    """Group agent-authored memory into recalled facts/findings/questions.

    ``memory`` is oldest-first; we keep the most RECENT items per kind (the tail)
    so a long session surfaces its latest learnings rather than stale early ones.
    """
    facts: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    questions: list[str] = []
    for m in (memory or []):
        kind = m.get("kind")
        text = redact_text(str(m.get("text", "")))[:300]
        if not text:
            continue
        if kind == "fact":
            facts.append({"text": text, "confidence": m.get("confidence") or "medium"})
        elif kind == "finding":
            findings.append({"title": text, "severity": m.get("severity") or "info"})
        elif kind == "open_question":
            questions.append(text)
    return {
        "recorded_facts": facts[-_MAX_FACTS:],
        "recorded_findings": findings[-_MAX_FINDINGS:],
        "open_questions": questions[-_MAX_FACTS:],
    }


def build_session_context(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    agent_memory: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Bounded, redacted context — the ONLY thing the model sees."""
    findings = []
    for f in (summary.get("findings") or [])[:_MAX_FINDINGS]:
        findings.append({
            "severity": str(f.get("severity", "info"))[:32],
            "confidence": str(f.get("confidence", "medium"))[:16],
            "title": redact_text(str(f.get("title", "")))[:200],
            "interpretation": redact_text(str(f.get("interpretation", "")))[:300],
            "source_run_id": str(f.get("source_run_id") or "")[:64],
        })
    context = {
        "session": {
            "title": redact_text(str(session.get("title", ""))),
            "goal": redact_text(str(session.get("goal") or "")),
            "status": session.get("status", "active"),
        },
        "summary": {
            "known_facts": [
                {"text": redact_text(str(f.get("text", "")))[:300],
                 "confidence": f.get("confidence", "medium"),
                 "source_run_id": str(f.get("source_run_id") or "")[:64]}
                for f in (summary.get("known_facts") or [])[:_MAX_FACTS]
            ],
            "findings": findings,
            "open_questions": [redact_text(str(q))[:300] for q in (summary.get("open_questions") or [])[:_MAX_FACTS]],
            # NOTE: the deterministic rule-engine "next_actions" menu is intentionally
            # NOT injected — the agent proposes its own next steps. (Removed in v0.20.)
            "limitations": [redact_text(str(x))[:300] for x in (summary.get("limitations") or [])[:_MAX_FACTS]],
        },
        # Things YOU recorded in earlier turns of this session (via note_fact /
        # record_finding / note_open_question). Reuse them; don't re-derive.
        "agent_memory": _build_agent_memory_block(agent_memory),
        "recent_messages": [
            {"role": m.get("role"), "content": redact_text(str(m.get("content", "")))[:1000]}
            for m in recent_messages[-_MAX_MESSAGES:]
        ],
        "safety_rules": SESSION_SAFETY_RULES,
    }
    guardrails.assert_no_secrets_in_context(context)
    return context


def render_context_text(context: dict[str, Any]) -> str:
    return json.dumps(context, indent=2, default=str)


def _make_agent(creds: dict[str, Any], tools: list[Any], instructions: str) -> Any:
    """Build the session Agent via the shared per-run builder (no SDK globals)."""
    from .agent_service import build_agent
    return build_agent(creds, tools, instructions, name="Storage Agent",
                       max_tokens=_MAX_COMPLETION_TOKENS, parallel_tool_calls=False)


# --- graceful step-budget finalize -----------------------------------------
# When the agent exhausts its turn budget (max_turns) the OpenAI Agents SDK
# raises MaxTurnsExceeded. That must NOT surface as a hard error: instead we make
# ONE tool-less model call that synthesizes a best-effort answer from the work
# already done. Tools are disabled, so the model can only emit text — the call is
# guaranteed to terminate with a grounded answer. The turn budget is preserved
# (N tool-loop turns + 1 tool-less finalize); nothing new can be probed here.

_FINALIZE_FALLBACK = (
    "I reached my investigation step budget before I could finish this. The steps "
    "I completed are shown above — tell me to continue and I'll pick up from there."
)


def _is_max_turns(exc: BaseException) -> bool:
    """True if exc is the SDK's max-turns signal. Matched by class name + message
    so we don't couple to the SDK's exception import path."""
    return type(exc).__name__ == "MaxTurnsExceeded" or "max turns" in str(exc).lower()


def _finalize_directive(activity: list[dict[str, Any]] | None) -> str:
    rows = activity or []
    trace = "\n".join(
        f"- {a.get('tool', '')} {a.get('target', '')}: {a.get('result', '')}".strip()
        for a in rows[-40:]
    ) or "- (no tool calls completed)"
    return (
        "\n\n[STEP BUDGET REACHED] You have used your investigation step budget — "
        "do NOT attempt any more tools. Using the context above and the "
        "investigation trace below, write your BEST answer now from what you "
        "already gathered. Be explicit that it is based on the investigation so "
        "far and may be incomplete, and offer to continue if the user wants a "
        "deeper look.\nInvestigation trace so far:\n" + trace
    )


def _finalize_agent_and_prompt(creds: dict[str, Any], prompt: str,
                               activity: list[dict[str, Any]] | None):
    """A TOOL-LESS agent + the original prompt augmented with a finalize directive
    and the investigation trace. Tools=[] guarantees the next call emits text."""
    return _make_agent(creds, [], instructions_for()), prompt + _finalize_directive(activity)


def _build_tools(conn: Any, function_tool: Callable, activity: list[dict[str, Any]] | None,
                 session_id: str | None, turn_id: str | None = None) -> list[Any]:
    """The agent's full read-only toolset (no autonomy toggle — always available)."""
    if conn is None:
        return []
    tools = session_tools.build(conn, function_tool, activity)
    tools += session_action_tools.build(conn, function_tool, activity, session_id, turn_id)
    # Working-memory tools are always available (recording is cloud-read-only).
    tools += session_memory_tools.build(conn, function_tool, session_id, activity)
    # Uploaded-file analysis is always available (local, read-only, sanitized) so
    # the agent can analyze an attached log/inventory itself and answer inline.
    tools += session_analysis_tools.build(conn, function_tool, session_id, activity)
    return tools


def _sdk_session_loop(spec: dict[str, Any]) -> Any:
    """Default loop via the OpenAI Agents SDK (lazy import) with read-only tools."""
    try:
        import openai  # noqa: F401
        from agents import Runner, function_tool
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable("OpenAI Agents SDK is not available in this environment.") from exc

    creds = spec["creds"]
    conn = spec.get("conn")
    try:
        tools = _build_tools(conn, function_tool, spec.get("activity"),
                             spec.get("session_id"), spec.get("turn_id"))
        agent = _make_agent(creds, tools, spec["instructions"])
        try:
            result = Runner.run_sync(agent, spec["prompt"], max_turns=_MAX_TURNS)
            return getattr(result, "final_output", "")
        except Exception as exc:  # noqa: BLE001
            if not _is_max_turns(exc):
                raise
            # Step budget hit → one tool-less call to synthesize a grounded answer.
            try:
                fa, fp = _finalize_agent_and_prompt(creds, spec["prompt"], spec.get("activity"))
                fr = Runner.run_sync(fa, fp, max_turns=2)
                return getattr(fr, "final_output", "") or _FINALIZE_FALLBACK
            except Exception:  # noqa: BLE001 - finalize must never re-raise
                return _FINALIZE_FALLBACK
    except AgentUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable(f"Session assistant failed: {redact_text(str(exc))}") from exc


# Monkeypatch in tests to inject a fake loop (no SDK / no API key).
SESSION_LOOP: Callable[[dict[str, Any]], Any] = _sdk_session_loop


def _build_prompt(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    user_message: str,
    conn: Any,
    attachments: list[dict[str, Any]] | None = None,
) -> tuple[str, list[str], dict[str, Any]]:
    """Build the sanitized prompt + skill names + context (shared).

    Skills follow progressive disclosure: the full catalog (name + description)
    goes in the prompt and the agent loads any relevant skill on demand via the
    read_skill tool. skill_names is the allow-list of what it may cite as used.
    """
    agent_memory: list[dict[str, Any]] = []
    if conn is not None and session.get("id"):
        try:
            from ..repositories import sessions as sessions_repo
            agent_memory = sessions_repo.list_agent_memory(conn, session["id"])
        except Exception:  # noqa: BLE001
            agent_memory = []
    context = build_session_context(session, summary, recent_messages, agent_memory)
    skill_names = skill_context.skill_names()

    prompt_parts = [render_context_text(context)]
    # Pre-list configured providers so the agent skips a list_providers round
    # trip (latency) and already knows the provider_id values. No secrets.
    providers: list[dict[str, Any]] = []
    if conn is not None:
        try:
            from ..repositories import cloud_providers as cloud_repo
            providers = [{"provider_id": p.id, "name": p.name, "type": p.provider_type,
                          "region": p.region, "endpoint": p.endpoint_url}
                         for p in cloud_repo.list_all(conn)]
        except Exception:  # noqa: BLE001
            providers = []
    prompt_parts.append("configured_providers:\n" + json.dumps(providers, ensure_ascii=False))
    # Files the user attached this turn (uploaded but not yet analyzed). The agent
    # should analyze the relevant one with analyze_uploaded_file and answer inline.
    if attachments:
        att = [{"dataset_id": a.get("id"), "filename": a.get("source_filename"),
                "type": a.get("dataset_type")} for a in attachments]
        prompt_parts.append(
            "attached_files (the user just uploaded these; analyze the relevant one with "
            "analyze_uploaded_file and base your answer on the result — do NOT ignore them):\n"
            + json.dumps(att, ensure_ascii=False)
        )
    catalog = skill_context.catalog_text()
    if catalog:
        prompt_parts.append(catalog)
    prompt_parts.append(f"User question:\n{redact_text(user_message)[:2000]}")
    prompt_parts.append(skill_contract.CONTRACT_INSTRUCTION)
    return "\n\n".join(prompt_parts), skill_names, context


def _finalize_contract(raw: Any, skill_names: list[str], activity: list[dict[str, Any]]) -> dict[str, Any]:
    contract = skill_contract.parse_agent_contract(raw, allowed_skill_names=skill_names)
    contract["answer"] = contract["answer"][:_MAX_OUTPUT]
    # Bind skills_used to skills the agent ACTUALLY loaded via read_skill this
    # turn — the model can't merely *claim* a skill it never opened (keeps the
    # report honest). read_skill records {tool, target=skill_name} in activity.
    read_skills = {a.get("target") for a in activity if a.get("tool") == "read_skill"}
    contract["skills_used"] = [s for s in contract.get("skills_used", []) if s in read_skills]
    contract["skills_offered"] = skill_names
    contract["tool_activity"] = activity
    return contract


def answer(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    user_message: str,
    creds: dict[str, Any],
    conn: Any = None,
    turn_id: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Skill-grounded, sanitized session answer contract. Raises AgentUnavailable.

    Returns {answer, skills_used, evidence_used, evidence_gaps,
    next_action_proposals} — all sanitized + CoT-stripped; proposals coerced +
    forbidden-token-filtered. StorageOps skills are injected as guidance only
    (tools/scripts disabled). The agent is a fully autonomous read-only
    investigator (no autonomy toggle).
    """
    prompt, skill_names, context = _build_prompt(session, summary, recent_messages, user_message,
                                                 conn, attachments)

    activity: list[dict[str, Any]] = []
    spec = {"context": context, "prompt": prompt, "instructions": instructions_for(),
            "creds": creds, "conn": conn, "activity": activity,
            "session_id": session.get("id"), "turn_id": turn_id}
    raw = SESSION_LOOP(spec)
    return _finalize_contract(raw, skill_names, activity)


# --- Streaming path (SDK-only; used by the SSE endpoint) --------------------

def build_stream(
    session: dict[str, Any],
    summary: dict[str, Any],
    recent_messages: list[dict[str, Any]],
    user_message: str,
    creds: dict[str, Any],
    conn: Any,
    turn_id: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
):
    """Set up a streaming run. Returns (result_streaming, activity, skill_names).

    Raises AgentUnavailable if the SDK/key is unavailable — caller should then
    fall back to the blocking endpoint.
    """
    try:
        import openai  # noqa: F401
        from agents import Runner, function_tool
    except Exception as exc:  # noqa: BLE001
        raise AgentUnavailable("OpenAI Agents SDK is not available in this environment.") from exc

    prompt, skill_names, _context = _build_prompt(session, summary, recent_messages, user_message,
                                                  conn, attachments)
    activity: list[dict[str, Any]] = []
    tools = _build_tools(conn, function_tool, activity, session.get("id"), turn_id)
    # _make_agent disables parallel tool calls (chat-completions providers like
    # DeepSeek can emit malformed follow-ups with streaming + parallel calls) and
    # uses a per-run client so concurrent sessions don't race on SDK globals.
    agent = _make_agent(creds, tools, instructions_for())
    result = Runner.run_streamed(agent, prompt, max_turns=_MAX_TURNS)

    async def _finalize() -> str:
        """One tool-less call to synthesize a grounded answer when the step budget
        is hit mid-stream. Never raises — returns a safe fallback on any error."""
        try:
            fa, fp = _finalize_agent_and_prompt(creds, prompt, activity)
            fr = await Runner.run(fa, fp, max_turns=2)
            return getattr(fr, "final_output", "") or _FINALIZE_FALLBACK
        except Exception:  # noqa: BLE001
            return _FINALIZE_FALLBACK

    return result, activity, skill_names, _finalize


async def stream_events_for(result: Any, activity: list[dict[str, Any]], skill_names: list[str],
                            finalize=None):
    """Yield ('delta', text) and ('tool', record) during the run, then
    ('final', contract) when complete.

    If the run hits its step budget (max_turns) and a ``finalize`` callable was
    provided, the cap is NOT surfaced as an error: we flush the tool trace, run a
    tool-less finalize to synthesize a grounded answer, and end with a normal
    'final'. The client therefore never sees a max-turns error (and never
    double-runs via the blocking fallback)."""
    from openai.types.responses import ResponseTextDeltaEvent
    emitted = 0
    try:
        async for event in result.stream_events():
            if getattr(event, "type", "") == "raw_response_event" and isinstance(event.data, ResponseTextDeltaEvent):
                if event.data.delta:
                    yield ("delta", event.data.delta)
            while len(activity) > emitted:
                yield ("tool", activity[emitted])
                emitted += 1
    except Exception as exc:  # noqa: BLE001
        if finalize is None or not _is_max_turns(exc):
            raise
        while len(activity) > emitted:
            yield ("tool", activity[emitted])
            emitted += 1
        text = await finalize()
        if text:
            yield ("delta", text)
        yield ("final", _finalize_contract(text or "", skill_names, activity))
        return
    while len(activity) > emitted:
        yield ("tool", activity[emitted])
        emitted += 1
    yield ("final", _finalize_contract(getattr(result, "final_output", "") or "", skill_names, activity))


__all__ = ["SESSION_LOOP", "build_session_context", "render_context_text", "answer",
           "build_stream", "stream_events_for", "SESSION_SAFETY_RULES", "INSTRUCTIONS"]
