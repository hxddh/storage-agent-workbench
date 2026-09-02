# Roadmap

> **Baseline: Storage Agent v1.11.0.** This file is the plan for
> **v1.12.0 — Native all the way through**: one runtime protocol, a push
> transport, a plan the model owns, an approval policy the runtime enforces,
> context that compacts instead of cutting off, and an Execution detail that
> reads from the same durable log as everything else. Every finding below was
> checked against the code on `main` at v1.11.0 (merge `9d73c16`) and carries
> a verdict: **keep**, **rebuild**, **new**, or **non-goal**. The v1.11.0
> plan this file replaces is recorded in `releases/1.11.0.md`.

## 1. Verdict on v1.11.0 — what still is not native

v1.11.0 made the *transcript* read like Codex. What remains is underneath it:
the runtime still has two protocols, the live path polls, the model cannot
say what it intends to do, the confirmation boundary is a single tool with
no policy behind it, and a full context window ends a turn instead of
compacting it.

| # | Finding (verified in code) | Where | Verdict |
| --- | --- | --- | --- |
| F1 | **Two runtime protocols.** The pre-v0.94 message API still ships beside the durable runtime: `POST /sessions/{id}/messages` blocks up to 150 s on `wait_for_completion`, `POST …/messages/stream` re-speaks the durable log in the legacy `delta / tool / done / error` vocabulary (`event_stream.legacy_frames`), `POST …/turns/{id}/cancel` and `GET …/turn` are a second cancel/status path, `POST …/actions/prepare` + `sessions/next_actions.py` (320 lines) prepare proposals that no longer exist, and `proposed_actions` is projected as an always-empty list. The frontend still carries `cancelSessionTurn`, `getSessionTurn` and four `/evidence-imports` clients with no UI behind them. | `routers/sessions.py`, `task_runtime/event_stream.py`, `sessions/next_actions.py`, `frontend/src/api.ts`, `useTurnRunnerImplementation.ts` | **rebuild** — one protocol |
| F2 | **The live path polls.** `execution_frames` sleeps 120 ms and re-queries SQLite per subscriber; the hub's `Condition` is notified on every event and awaited by no one. The client re-polls `/agent-tasks/{id}/state` every 1–1.5 s for the whole run to notice queued Directions and approvals it already receives as events. | `event_stream.py` (`_POLL_S`), `hub.py`, `useSessionDocument.ts` (`tick`) | **rebuild** — push |
| F3 | **The model cannot state a plan.** Codex's `update_plan` gives a multi-step investigation a live checklist the runtime owns. Our Agent has no plan tool, so a ten-tool turn is commentary sentences and one folded group. CLAUDE.md forbids *synthetic* plans; a plan the runtime records from a tool call is real runtime state. | `agent_runtime/session_tools.py` (no plan tool), transcript | **new** |
| F4 | **"Worked for" is not wall-clock.** The group label sums `duration_ms` of its rows; parallel calls under-count, a seeded group reads "Worked for 0ms". Codex shows elapsed time of the work. | `WorkedGroup.tsx` (`sum += item.duration_ms`) | **rebuild** |
| F5 | **One gate, no policy.** `import_evidence` is the only tool that asks; "Allow for this task" is the only scope; Settings → Safety is a paragraph. `survey_account(max_buckets≤500)` is a materially large live scan with no boundary, which security §7 says must cross one. Codex has an approval policy the runtime enforces. | `gated_tools.py`, `runtime.request_approval`, `session_action_tools.py`, `SettingsDialog.tsx` | **new** + **rebuild** |
| F6 | **A full window cuts the turn.** Tool outputs are compacted step by step, but the conversation never is: on overflow the turn ends with `_CONTEXT_CUT_MARKER` and asks the user to continue. The context meter reports the fill; nothing acts on it. Codex auto-compacts and continues. | `finalize.py`, `guards._compact_consumed_outputs`, `stream.py`, `ContextMeter.tsx` | **new** |
| F7 | **Execution detail is the v0.5x run page under a new header.** `ExecutionDetailImplementation` (325 lines) opens its own `EventSource` on `/runs/{id}/events` — a third stream vocabulary — and reads `tool_calls` through the run API rather than the execution's durable event log. | `components/ExecutionDetailImplementation.tsx`, `/runs` router | **rebuild** |
| F8 | **The document still carries everything.** `AgentTaskImplementation.tsx` (673 lines) owns composer state, find, banners, approvals, paging and palette publication; the runner (651 lines) keeps the legacy cancel branch; `api.ts` (942 lines) mixes the runtime client with retired clients. | `frontend/src/components`, `hooks`, `api.ts` | **rebuild** — split |
| F9 | **No project instructions.** Codex reads `AGENTS.md`; the Agent has user skills (`STORAGE_AGENT_DATA_DIR/skills`) but no standing instructions file a user can keep next to their data (naming conventions, buckets in scope, reporting language). | `prompt.py`, `skills/` | **new** |
| F10 | **Reasoning summaries.** Codex shows the provider's reasoning *summary* above the work. Security rule 10 keeps chain-of-thought out of persistence and out of the UI; a provider-authored summary is still model reasoning text. | `security.md` §10 | **non-goal** (stays) |

Everything else from v1.11.0 — the transcript turn, inline approvals, the
Artifacts panel, day groups, titles, reasoning effort, the OS shell — is
**keep**.

## 2. Codex parity checklist — what v1.12.0 must close

| Codex | Storage Agent v1.11.0 | v1.12.0 |
| --- | --- | --- |
| One protocol between app and runtime | durable runtime + three legacy shims | durable runtime only |
| Server pushes events | 120 ms SQLite poll per subscriber + 1.5 s client poll | hub-driven SSE, no client poll while following |
| `update_plan` → live checklist | none | `update_plan` tool, `plan.updated` event, checklist in the turn |
| Elapsed "Worked for 1m 12s" | sum of call durations | wall-clock from first row to last |
| Approval policy (ask / on-request / never), enforced by the runtime | per-task grant only | Safety → approval policy, server-side, applies to every gated tool |
| Large operations ask | `survey_account` up to 500 buckets unasked | over-cap survey is a gated call |
| Auto-compaction when the window fills | turn cut short | summarise-and-continue, `context.compacted` marker |
| `/compact`, `/status` | context meter only | palette: Compact context; meter shows compaction |
| Detail of a tool call from the same log | second stream on `/runs` | execution detail from `execution_events` + `tool_calls` |
| AGENTS.md | user skills only | `AGENTS.md` in the data directory, bounded, in the stable prompt half |
| Reasoning summary | not shown | not shown (rule 10) |

## 3. Workstreams (all mandatory for v1.12.0)

### W1 — One protocol (F1)

- Remove `POST /sessions/{id}/messages`, `POST …/messages/stream`,
  `POST …/turns/{id}/cancel`, `GET …/turn`, `POST …/actions/prepare`,
  `event_stream.legacy_frames`, `_turn_result_envelope`, `sessions/next_actions.py`,
  `turn_guard`'s HTTP-turn registry where only the shims used it, and the
  `proposed_actions` field from `SessionMessage` / `work_results.proposals`
  (column stays; migration 030 is not needed — nothing is written).
- `/sessions` keeps CRUD, read, fork, memory, runs linkage, activity/audit/overview,
  report, datasets. Every write that starts work goes through `/agent-tasks`.
- Frontend: delete `cancelSessionTurn`, `getSessionTurn`, the `/evidence-imports`
  clients, `SessionTurnState`; the runner has one cancel path (`stopTaskExecution`).
- Tests: the ~40 Sidecar tests that drive turns through `/sessions/{id}/messages`
  move to `POST /agent-tasks/{id}/executions` + `wait`; `test_streamed_loop_regression`,
  `test_v063_*`, `test_session_streaming` follow the durable stream.

### W2 — Push transport (F2)

- `hub`: one `asyncio.Condition` per execution (bridged from the worker thread
  with `loop.call_soon_threadsafe`); `execution_frames` awaits it with a
  bounded timeout (heartbeat) instead of `sleep(0.12)`; a wake drains the
  ordered snapshot exactly as today.
- New durable event `task.status` `{status, active_execution_id, queued: [...],
  pending_decisions: [...]}` appended whenever `refresh_task_status` changes
  something, so the client following an execution learns about queued
  Directions and approvals from the stream and stops polling `/state`.
- `useSessionDocument`: `tick` only on attach, on visibility change, and on
  `end`; never on an interval while a follower is open.
- Contract test: a 20 s follow of an idle execution issues zero SQLite reads
  after the first drain (count via a connection trace hook).

### W3 — Plan the model owns (F3)

- Tool `update_plan(steps: [{text, status}])` in CORE, bounded (≤ 12 steps,
  ≤ 160 chars each, sanitized, statuses `pending | in_progress | completed`);
  the whole list is replaced on each call (Codex semantics).
- Runtime: `plan.updated` durable event with the full list; the latest plan is
  persisted as a `{"kind": "plan"}` turn item so a reload reproduces it.
- Transcript: a quiet checklist card at the position of the first
  `update_plan` in the turn, updated in place (no new card per call), collapsed
  once every step is completed; live it shows the in-progress step's caret.
- Prompt: one sentence — use `update_plan` for work that needs three or more
  distinct steps; keep it current; never plan trivial work.
- Non-goal stays: the UI never invents steps; a plan exists only when the tool
  was called.

### W4 — Approval policy and the scan boundary (F5)

- Setting `approval_policy` in `app_settings` (`ask` default · `allow_session`
  · `allow_always`), exposed on `/settings`, enforced only in
  `runtime.request_approval`: `allow_session` records an already-approved
  Decision for the process lifetime, `allow_always` for the data directory;
  `ask` is today's behaviour. Settings → Safety becomes a native pane: the
  policy control, the read-only floor statement, and the list of gated tools.
- `survey_account`: the default cap stays autonomous; a call with
  `max_buckets` above the default (or a truncated prior survey asking for the
  rest) goes through `request_approval` with impact `{buckets, provider,
  estimated_calls}` — the same card, `action_type = survey_account_large`.
- Approval card shows which policy is in force when it was auto-approved
  (`approval.granted` gains `policy`).
- Security §7/§8 rewritten around the policy; the floor is unchanged (no
  policy can approve a tool that does not exist).

### W5 — Context compaction (F6)

- When the reported usage of the last model call crosses 80 % of
  `model_budget.context_window`, the runtime runs one tool-less **compaction
  step** (`agent_runtime/compaction.py`): summarise the replayed messages and
  tool trace into a bounded, redacted `context_summary` (≤ 2 000 chars), store
  it on the task (`task_context_versions` gains `summary`), append
  `context.compacted {before_tokens, after_tokens}`, and continue the same
  execution with the summary in place of the older replay. Never a second
  Agent, never persisted raw rows, never chain-of-thought.
- The overflow fallback (`_CONTEXT_CUT_MARKER`) stays as the last resort only.
- Transcript: a one-line marker "Context compacted · 48k → 9k tokens" between
  segments; the context meter drops accordingly. Palette: **Compact context**
  (⌘K) runs the same step on demand for a task with no live execution.

### W6 — Execution detail and frontend split (F4, F7, F8)

- `ExecutionDetailImplementation` rewritten on the durable runtime: header
  from `task_executions`, rows from `execution_events` (`tool.*`, `plan.updated`,
  `approval.*`, `context.compacted`) joined to `tool_calls` for input/output,
  findings and result from the Work Result — no `EventSource`, no `/runs` API
  in the product UI. `/runs` stays as the deterministic engine API.
- "Worked for" = wall-clock of the group (first `tool.started` → last
  `tool.completed`, live from `started_at`), durable rows carry the same.
- Split: `AgentTaskImplementation` → `TaskDocument` (transcript + paging + find),
  `TaskBanners`, `TaskComposerHost` (composer state, attach, steer/stop wiring),
  `useApprovals`; the runner loses its legacy branch; `api.ts` → `api/runtime.ts`,
  `api/tasks.ts`, `api/settings.ts`, `api/providers.ts`. Orphan and architecture
  contracts updated.

### W7 — Instructions file, contracts, release (F9)

- `STORAGE_AGENT_DATA_DIR/AGENTS.md` (and `STORAGE_AGENT_INSTRUCTIONS` override):
  Markdown only, ≤ 8 000 chars, redacted, never executed, injected in the
  stable prompt half after the skills catalog; `GET /settings/instructions`
  reports whether one is loaded; Settings → Skills & bridges gains **Open
  instructions file**.
- Contracts: Sidecar `test_v112_native_protocol.py` (no shim routes, push
  transport, plan tool + event, policy enforcement, over-cap survey gate,
  compaction step, execution detail projection); frontend architecture v1.12
  block; E2E: plan checklist, policy pane, compaction marker, execution detail
  from the durable log; gallery captures for each.
- Docs: `api.md` (removed routes, new events), `security.md` (§7/§8 policy),
  `tools.md` (`update_plan`, gated survey), `data-model.md` (`app_settings`
  key, `task_context_versions.summary`), `product.md`, CLAUDE.md, CHANGELOG,
  `releases/1.12.0.md`.

## 4. Non-goals for v1.12.0

- Reasoning summaries in the transcript (rule 10).
- An MCP *client* (consuming third-party tool servers) — a new trust boundary.
- Multi-agent orchestration, sub-agents, worktrees, code diffs, terminal or
  browser control, storage mutation.
- Signed/notarised builds (operations, not code — see `signing.md`).

## 5. Release plan

Branch from `main`; one PR carrying W1–W7 with the gates in CLAUDE.md §12;
migration 030 only if `task_context_versions.summary` needs a column (it does;
append-only); version stamp 1.12.0; merge; `release/v1.12.0`.
