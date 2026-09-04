"""Runtime limits, budgets, tool groups and stream markers shared by the Agent runtime modules."""

from __future__ import annotations

from typing import Any

from . import model_budget

# FLOORS for the deterministic-summary items shown to the model; the effective
# cap is _elastic_memory_cap (scales with the window, ceiling _MEM_RECALL_CEIL).

# The PERSISTED summary holds up to summary_builder.MAX_FACTS/MAX_FINDINGS (200),
# so the elastic cap has something to reveal on a large-window model.
_MAX_FACTS = 50
_MAX_FINDINGS = 50
_MEM_RECALL_CEIL = 400  # upper bound on the elastic agent-memory recall


def _elastic_memory_cap(model: str | None, explicit_window: int | None) -> int:
    """How many of the agent's OWN recorded facts/findings/questions to recall,
    scaled to the model window (floored at 50) — the same de-ossification the
    thread replay uses. On a long investigation with a large-context model, the
    agent's durable memory was the first thing clipped at a hard 50."""
    window = model_budget.context_window(model, explicit_window)
    factor = max(1, window // 128_000)
    return min(_MEM_RECALL_CEIL, _MAX_FACTS * factor)
# How many recent thread messages the agent sees. 24 (was 12): a small-context
# clip that now just makes the agent lose the thread on a long investigation.
# This is the FLOOR: build_session_context scales COUNT up with the model window
# (bounded by _MAX_MESSAGES_CEIL). Assistant Work Results are digested to
# `_MAX_REPLAY_ANSWER` — replaying the full markdown every turn restates
# agent_memory. User Directions stay at `_MAX_REPLAY_MSG`.
_MAX_MESSAGES = 24
_MAX_MESSAGES_CEIL = 96
# Tool-trace lines replayed per prior assistant turn. Each message already
# persists its tool_activity (the one-line-per-call trace shown in the UI); we
# surface it into the next turn's context so the agent sees WHAT it already
# probed and doesn't re-run the same checks. Cheap continuity — already-persisted,
# already-sanitized data; not summarization/compaction.
# Match _MAX_TURNS: a turn can run ~that many probes, and the NEXT turn's
# continuity should see the whole trace (tail-kept), not a 15-line head that
# dropped the decisive later probes. ~180 chars/line stays comfortably inside
# the (now elastic) per-turn budget. Defined AS _MAX_TURNS (below) so the two
# can't drift apart again (they did: 40 vs 60 after v0.27.0).
_MAX_REPLAY_TOOLS = 60  # == _MAX_TURNS; assert below keeps them in lockstep
# Enumerations can be large (e.g. 96+ buckets in a table). FLOOR of the answer
# cap, not the cap itself: _answer_cap() scales it to ≥ ~4 chars/token of the
# model's completion budget, so post-processing can never truncate an answer the
# completion budget legitimately allowed — and when the cap IS hit, the cut is
# marked (_ANSWER_CUT_MARKER), never silent (same rule as every other budget).
_MAX_OUTPUT = 48000
# Without an explicit max_tokens the provider applies a small default; for a
# reasoning model (e.g. deepseek-v4-pro) the thinking budget then leaves almost
# nothing for the answer, truncating long enumerations mid-table. This floor
# (16384 tokens ≈ 65k chars) comfortably covers the _MAX_OUTPUT answer floor,
# so the prompt's full-enumeration mandate always fits the completion budget.
# (The installed Agents SDK's chat-completions streaming path does not surface
# finish_reason, so a provider-side length cut cannot be detected here — the
# generous budget is the mitigation.)
_MAX_COMPLETION_TOKENS = 16384
# A real investigation chains several probes (test_credentials → head_bucket →
# test_addressing_style → list_objects → head_object …); keep a generous but
# bounded ceiling so multi-step diagnoses complete without runaway loops.
# 40 (was 24/16): the RIGHT governor of turn depth is the tool-OUTPUT budget
# below (elastic on the context the model actually consumes), not this raw step
# count. This ceiling is now demoted to a runaway-loop SAFETY stop set well above
# what a real deep investigation needs — so a shallow-output but deep probe (many
# small head/list/latency calls across buckets) is no longer cut short at an
# arbitrary step number, while a heavy-output one is still bounded by real context
# use. The tool-less finalize pass still guarantees termination, and the
# context-overflow → finalize path is the backstop if a provider window is hit.
# 60 (was 40): real depth is governed by the elastic tool-output budget
# (model_budget), so this is only the runaway-loop SAFETY stop — set it high
# enough not to clip a legitimately long adaptive investigation on a large model.
_MAX_TURNS = 60
assert _MAX_REPLAY_TOOLS == _MAX_TURNS, "replay must cover a full turn's probes"

# Per-tool wall-clock ceiling (v0.56.0). The SDK has offered `timeout_seconds`
# all along and nothing set it, so a single call had NO time bound: an endpoint
# that accepts a TCP connection and then never answers — precisely the failure
# this product exists to diagnose — could hold a turn open indefinitely, with the
# user watching a spinner and no way to learn which step was stuck.
#
# 120s is deliberately generous. botocore already retries internally and a cold
# ListObjectsV2 over a large prefix on a slow gateway legitimately takes tens of
# seconds; this is the "something is wrong" bound, not a performance target. The
# heavier survey/review tools opt into a longer one below.
#
# `error_as_result` (not `raise_exception`) keeps a timeout in the same shape as
# every other bounded failure in this product: the agent receives it as a tool
# RESULT it can reason about and route around, instead of the turn dying.
# How many of a step's tool calls may execute at once (v0.61.0).
#
# v0.54.0 turned on `parallel_tool_calls`, and the SDK's default for
# `max_function_tool_concurrency` is None — documented as "starts ALL function
# tool calls emitted in a turn". So a model emitting fifteen `head_object` calls
# fired fifteen concurrent S3 requests, with nothing between the model's whim and
# the endpoint. That is the opposite of the discipline this product applies
# everywhere else: the account survey bounds its own probes to
# `_PROBE_WORKERS = 4` precisely because an unbounded fan-out at a
# self-hosted MinIO or Ceph endpoint is how a diagnostic turns into a load test.
#
# 6, not 4: this is one step of an interactive turn rather than a bulk walk, the
# calls are usually different tools against different buckets, and the latency
# saved by overlapping them is the whole reason parallel calls are on. It stays
# well under any provider's per-connection concurrency expectations, and the
# SDK queues the rest rather than dropping them — nothing is lost, only paced.
_MAX_PARALLEL_TOOLS = 6
_TOOL_TIMEOUT_S = 120.0
# Account survey / bucket-config review walk many buckets in one call and are
# already internally bounded; they need room the single probes do not.
_SLOW_TOOL_TIMEOUT_S = 900.0
# Per-model-call ceiling (openai-agents 0.21.1). The turn's slowest component was
# also its only unbounded one: every tool has had a ceiling since v0.56.0, while a
# model call inherited the OpenAI client's 600 s read timeout — and the client
# retries twice, so a stalled endpoint could hold a turn for ~30 minutes.
#
# 300 s, not 120 s: the SDK's deadline covers the WHOLE attempt including the
# streamed answer, so a tight value would cut off a legitimately long answer
# rather than a hang. This is a hang bound, not a latency target — it must sit
# above the slowest honest answer, and the number to compare it against is the
# 600 s it replaces.
#
# A trip is RECOVERABLE, not fatal: `_is_model_timeout` routes it into the same
# finalize salvage as a 429, so the turn answers from the trace it already has
# instead of discarding the investigation.
_MODEL_TIMEOUT_S = 300.0

# --- mid-turn tool-output compaction (v0.57.0) -------------------------------
# Measured on the same 8-tool turn used throughout: after v0.56.0 the turn costs
# 94,817 input tokens, of which tool outputs are 31,522 (33%) — now co-equal with
# the fixed prefix as the largest single component. Splitting that 33%:
#
#   first delivery of each output      23,100 chars   5,775 tok
#   RE-SENDS of already-consumed output 100,900 chars  25,225 tok  = 81%
#
# An 8,000-char skill body or a 1000-key listing page that the agent read at
# step 3 is re-sent at full price on steps 4 through 9. Compacting an output
# once it is _COMPACT_AFTER_STEPS old cuts tool-output cost ~60% (~20% of the
# whole turn).
#
# This is done through the SDK's `call_model_input_filter`, which hands us the
# exact input list about to go to the model and takes a modified one back — a
# supported hook, not history surgery. v0.54.0 deferred this as "riskier, wants
# its own release"; the hook is what makes it safe to do now.
#
# Two rules keep it honest:
#  - the head of the payload SURVIVES (a listing's first entries are usually the
#    part that was actually being reasoned about), and
#  - the cut is stated in the item itself, never silent — the same rule every
#    other bound in this product follows.
#
# 1, not 2: the model has already used a result on the next step. Keeping it
# full for two extra steps was the majority of the re-send bill.
_COMPACT_AFTER_STEPS = 1      # how many later tool results before one is compacted
_COMPACT_MIN_CHARS = 800      # below this there is nothing worth reclaiming
_COMPACT_KEEP_HEAD = 500      # of a non-JSON payload, kept verbatim
# First delivery to the model: a payload larger than this is reduced to a
# structured digest BEFORE the model sees it. Typical list_objects pages stay
# under this; surveys, aggregates, and 1000-key dumps do not. The full payload
# is still audited; the model can call again with a tighter bound.
_FIRST_DELIVERY_CHARS = 6000
# Skill bodies are the method the model asked to load; the plan checklist is
# a few bytes. Neither is a listing dump.
_FIRST_DELIVERY_EXEMPT = frozenset({"read_skill", "update_plan"})
# Tool descriptions ride in every step's prefix. Prose over this is shortened
# to the first sentence plus Args.
_TOOL_DESC_LIMIT = 240

_SLOW_TOOLS = {"survey_account", "review_bucket_config", "analyze_uploaded_file",
               "aggregate_uploaded_file", "aggregate_imported_evidence",
               "read_run_result"}
# Bound on the user's message as embedded in the prompt. Truncation is NEVER
# silent: the cut is marked in the prompt so the agent knows it saw a prefix
# (see build_session_prompt) — the same "no silent caps" rule as ingestion.
# FLOOR: scaled up with the model window (capped at the CEIL) — pasted error/
# config dumps are a core flow and 16k chars ≈ 4k tokens clipped real dumps on
# large-window models while the rest of the context went elastic in v0.27–28.
_MAX_USER_MSG = 16000
_MAX_USER_MSG_CEIL = 64000
# Bound on each replayed prior USER Direction. Also never silent.
# 4000 (was 1000): pasted error/config dumps are a core flow; 1000 chars
# clipped mid-Direction. Assistant Work Results use `_MAX_REPLAY_ANSWER`.
_MAX_REPLAY_MSG = 4000       # FLOOR; scaled up with the model window, capped below
_MAX_REPLAY_MSG_CEIL = 12000
# Assistant replay is a digest: tools_run already says what was probed, and
# agent_memory / conversation_summary already hold the conclusion. 600 chars
# is enough to see how the last answer was framed without re-paying a table.
_MAX_REPLAY_ANSWER = 600
# Per-turn cumulative budget on tool OUTPUT characters handed to the model.
# This is the PRIMARY, elastic governor of how deep a turn goes: it tracks the
# context the model actually consumes, so a turn runs as deep as it needs until
# real context pressure (not an arbitrary step count) says to synthesize. A
# bound, not a gate — once exhausted, further tool calls return a short note
# telling the model to synthesize, so a context-window overflow never becomes a
# hard failure mid-investigation.
# 48k chars ≈ 12k tokens — a floor, not a 128k-window filling 50k-token dump.
# model_budget scales this with the window (12 %); this constant is the fallback
# when no model is known.
_MAX_TOOL_OUTPUT_CHARS = 48_000
_TOOL_BUDGET_EXHAUSTED = (
    "This turn's tool-output budget is used up — synthesize your findings from what "
    "you've already gathered and answer now. This budget resets if the user continues."
)
_TOOL_OUTPUT_TOO_LARGE = (
    "This result was too large for the turn's remaining context budget and was "
    "withheld. Narrow it — a smaller max_keys, a prefix, or a filter — and call "
    "again, or answer from what you already have."
)
# Memory tools stay usable even after the budget is spent: recording a finding
# is how the model synthesizes, and their outputs are a few bytes.
# Tools whose repetition is the POINT, so an identical call is not a repeat.
# measure_request_latency exists to sample the same endpoint more than once;
# collapsing its second call into a pointer would silently turn a latency
# comparison into a single measurement.
_DEDUPE_EXEMPT_TOOLS = {"measure_request_latency"}

_BUDGET_EXEMPT_TOOLS = {
    "note_fact", "record_finding", "note_open_question",
    "update_memory_item", "resolve_memory_item",
    # App-generated status text, never rows; and it blocks on the user.
    "import_evidence",
    # The plan checklist: a few bytes, never data.
    "update_plan",
}
# Tools that wait on a HUMAN (an inline approval) get no wall-clock ceiling:
# the user's Stop is their bound.
_NO_TIMEOUT_TOOLS = {"import_evidence"}

# --- progressive tool disclosure (v0.55.0) -----------------------------------
# Measured on the real 42-tool agent: the tool block is 35,521 chars (~8,880
# tokens) and it is re-sent on EVERY step. On a realistic 8-tool turn (9 model
# requests) the fixed prefix — system prompt plus tool schemas — is 91,566
# tokens, **57% of the turn's entire input bill**. v0.53.0 and v0.54.0 shrank the
# context and the tool outputs; together those are 32%. This is the other half.
#
# A typical turn calls 3-8 tools. The rest are paid for on every step and never
# used. So: CORE is always exposed, and everything else is grouped and gated
# behind the SDK's per-tool ``is_enabled`` — which ``Agent.get_all_tools``
# re-evaluates on every step, so a group unlocked by the ``load_tools`` tool is
# visible on the very next one. Nothing is ever permanently hidden; the agent
# can always ask.
#
# Measured cost of the gate, including the extra round-trip an unlock costs:
#   3 calls: -20% (unlock) / -40% (core only)
#   8 calls: -21% (unlock) / -31% (core only)
#  20 calls: -15% (unlock) / -20% (core only)
_CORE_TOOLS = {
    # Orientation and the two probes every investigation starts from.
    "list_providers", "list_buckets", "test_credentials", "head_bucket",
    "get_bucket_location", "list_objects", "head_object",
    # Progressive disclosure of METHOD, and the group unlock itself.
    "read_skill", "load_tools",
    # Working memory: recording is how the agent synthesizes, and the payloads
    # are a few bytes — gating them would only cost a round-trip.
    "note_fact", "record_finding", "note_open_question",
    "update_memory_item", "resolve_memory_item",
    # The plan the model owns — always at hand, never gated.
    "update_plan",
}

_TOOL_GROUPS: dict[str, tuple[str, frozenset[str]]] = {
    "object_forensics": (
        "one object's ACL / tags / lock / checksums / a bounded preview / range "
        "+ conditional GET — 'why is THIS key wrong?'",
        frozenset({"get_object_acl", "get_object_tagging", "get_object_lock_status",
                   "get_object_attributes", "preview_object", "test_range_get",
                   "test_conditional_get"})),
    "endpoint_probes": (
        "live endpoint behaviour — latency percentiles, TLS certificate, "
        "path-style vs virtual-host, a pasted presigned URL",
        frozenset({"measure_request_latency", "inspect_endpoint_tls",
                   "test_addressing_style", "diagnose_presigned_url"})),
    "storage_pileup": (
        "what is silently accumulating — object versions, delete markers, "
        "incomplete multipart uploads and their parts",
        frozenset({"list_object_versions", "list_multipart_uploads",
                   "list_upload_parts"})),
    "bucket_config": (
        "bucket configuration and the four review lenses (security, lifecycle, "
        "observability, cost) plus the performance profile",
        frozenset({"get_bucket_config_summary", "get_bucket_config_detail",
                   "review_bucket_security", "review_bucket_lifecycle",
                   "review_bucket_observability", "review_bucket_cost_optimization",
                   "review_bucket_performance_profile", "review_bucket_config"})),
    "uploaded_files": (
        "local data already on this machine — a file the user attached, or "
        "evidence this session already imported: list it, analyze it, aggregate it",
        frozenset({"list_uploaded_files", "analyze_uploaded_file",
                   "aggregate_uploaded_file", "list_imported_evidence",
                   "aggregate_imported_evidence"})),
    "evidence_import": (
        "move a DISCOVERED evidence source (S3 Inventory, server access logs) "
        "onto this machine for deterministic analysis — pauses for the user's "
        "approval inside the turn; the only data-moving tool",
        frozenset({"import_evidence"})),
    "account_wide": (
        "the whole account — survey it, query the persisted profile, diff against "
        "the last survey, read a backgrounded run's result",
        frozenset({"survey_account", "query_account_profile",
                   "compare_to_last_survey", "read_run_result"})),
    "storage_engines": (
        "deterministic cost, lifecycle plans, baselines, Drift, price-table "
        "status, and optional revisits — never invent dollars",
        frozenset({"simulate_storage_cost", "draft_remediation_plan",
                   "verify_remediation_plan", "capture_task_baseline",
                   "compare_task_drift", "get_price_table_status",
                   "set_task_revisit_days"})),
}

# tool name -> the group that gates it (empty for CORE).
_GROUP_OF_TOOL: dict[str, str] = {
    name: group for group, (_desc, names) in _TOOL_GROUPS.items() for name in names
}


# How far back the unlock memory reaches, in tool calls. v0.55.0 seeded from
# the session's ENTIRE history, which made unlocking a one-way ratchet: a group
# touched once stayed open for every later turn, so a long investigation
# converged on carrying all 43 schemas forever. Measured (v0.58.0): the gated
# schema block is 8,507 chars cold and 34,826 fully open — 26,319 chars, ~6,579
# tokens, re-sent on EVERY step. An 8-step turn pays ~52,600 tokens for tools it
# is not using, and a trivial follow-up question pays the same as the scan that
# opened them.
#
# 40 is chosen against the product's own numbers, not picked round: a typical
# turn runs ~8 tool calls, so 40 spans roughly the last five turns of real work
# — a continuing investigation never re-unlocks — while a single heavy turn (the
# survey path can issue dozens) still keeps everything it just used. The
# alternative, decaying by wall-clock, misreads how these sessions are worked:
# an operator leaves a thread open for hours and returns mid-investigation.
_UNLOCK_RECENT_CALLS = 40


def seed_unlocked_groups(conn: Any, session_id: str | None,
                         has_attachments: bool = False) -> set[str]:
    """Which gated groups this turn starts with already open.

    Two seeds, both FACTS about the session rather than a guess at the question:

    - **What this session used RECENTLY.** A bucket-configuration investigation
      asks a second and a third question about bucket configuration. Re-charging
      the unlock round-trip every turn would spend more than the gate saves, so
      the groups whose tools appear in the last ``_UNLOCK_RECENT_CALLS`` calls
      start open. This is memory, not planning — the tools genuinely ran — and it
      is a WINDOW rather than the whole session, so the cost decays back down
      when an investigation moves on instead of ratcheting to the maximum and
      staying there.
    - **An attached file.** The user putting a file in the composer is not a
      prediction about intent; the file is there, and the whole point of
      attaching it is that it gets analyzed.

    Everything else starts closed and the agent opens it with ``load_tools``.
    Nothing is lost when the window slides past a group: ``load_tools`` still
    reaches it in one cheap call, which is the whole design.

    Best-effort: a bookkeeping failure must never cost the agent a capability, so
    any error falls back to the empty set (the agent can still unlock)."""
    seeded: set[str] = {"uploaded_files"} if has_attachments else set()
    if conn is None or not session_id:
        return seeded
    try:
        # Ordered by rowid as well as created_at: created_at has one-second
        # resolution here, and a turn issues many calls inside one second, so
        # timestamp alone would slice the window at an arbitrary point within a
        # burst. rowid breaks the tie in true insertion order.
        rows = conn.execute(
            "SELECT tool_name FROM tool_calls WHERE session_id = ? "
            "ORDER BY created_at DESC, rowid DESC LIMIT ?",
            (session_id, _UNLOCK_RECENT_CALLS)).fetchall()
    except Exception:  # noqa: BLE001
        return seeded
    for r in rows:
        group = _GROUP_OF_TOOL.get(r[0])
        if group:
            seeded.add(group)
    return seeded


def tool_group_catalog() -> str:
    """The one-line-per-group menu the model needs to know what it can unlock.

    ~600 chars against the ~27,600 of gated schemas it replaces. Kept in the
    instructions — the most stable, most cacheable part of the prompt."""
    lines = [f"- {g}: {desc}" for g, (desc, _names) in _TOOL_GROUPS.items()]
    return "\n".join(lines)
# SEC4: mechanical untrusted-data envelope. The prompt has always TAUGHT that
# tool-result content (object keys, previewed bodies, log lines, config rules)
# is third-party data, not instructions — but the boundary was invisible in the
# transcript, so an injected directive sat indistinguishable from runtime text.
# Every data-deriving tool output is wrapped in these markers (and any literal
# occurrence of a marker INSIDE the payload is defanged first, so content can't
# fake an early close and smuggle text outside the envelope). Exempt: the
# memory tools (short acks of agent-authored notes) and read_skill (first-party
# StorageOps teaching — skills ARE instructions by design).
_UNTRUSTED_OPEN = "<<external_untrusted_data>>"
_UNTRUSTED_CLOSE = "<<end_external_untrusted_data>>"
_ENVELOPE_EXEMPT_TOOLS = _BUDGET_EXEMPT_TOOLS | {"read_skill"}
# Streaming sanitization: hold back a short tail so a secret completing across
# deltas can never leak an un-redacted prefix; flushed at end of stream.
_STREAM_TAIL_HOLDBACK = 128
_STOPPED_MARKER = "_[stopped by user]_"
_CONTEXT_CUT_MARKER = (
    "_[investigation cut short: the model's context window filled up before the "
    "investigation finished]_"
)
_BUDGET_CUT_MARKER = (
    "_[investigation cut short: this turn's tool-output budget was used up. This is "
    "a best-effort answer from what was gathered — continue for a deeper look.]_"
)
_TRANSIENT_CUT_MARKER = (
    "_[a temporary provider error interrupted this turn: this is a best-effort answer "
    "from the investigation so far — resend to continue.]_"
)
