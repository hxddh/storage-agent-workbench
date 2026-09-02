# Sidecar API

> **Storage Agent v1.08.0 API reference.** Provenance projection unchanged from v1.02.0; v1.03 adds Skills, Observability export and MCP bridge, v1.04 keeps the window and adds warm editorial + Codex/Cursor layout. Unchanged from
> v0.98.0. No migration. Runtime, tools, and other `/agent-tasks` contracts
> are unchanged from v0.96.0. Engine endpoints such as `/settings/price-table`
> remain; they are not product destinations.
>
> The public product model is Agent Task / Direction / Execution / Decision / Work Result / Artifact. Many HTTP paths intentionally retain historical `session`/`run` compatibility names. Do not mirror those path names into new product information architecture.

The Python Sidecar binds to localhost on a port selected by the Tauri launcher. In development it defaults to `http://127.0.0.1:8765` unless `VITE_SIDECAR_URL` overrides the frontend target.

Request/response schema definitions live in `sidecar/app/models/schemas.py`; routers live under `sidecar/app/routers/`.

## Local authorization

When `STORAGE_AGENT_AUTH_TOKEN` is set by the packaged Tauri launcher, every non-exempt request must present the per-launch shared secret:

- normal HTTP: `X-Sidecar-Token: <token>`;
- header-less `EventSource`: `?token=<token>`.

Exempt:

- `GET /health`;
- CORS preflight `OPTIONS`.

The comparison is constant-time. Packaged uvicorn access logging is disabled so an SSE query token is not written to access logs. In plain development/tests, when the environment variable is absent, this auth layer is open.

Binding to `127.0.0.1` is network isolation, not local-process authorization; the token is the packaged local-process gate.

## Product-level Agent Task projection

### `GET /agent-tasks`

Returns the global task-navigation projection.

Query:

- optional `q` for task search.

The endpoint adapts durable `sessions` rows into product-level Task summaries and adds:

- `requires_decision` — read from the first-class durable `task_decisions` table (v0.94), never re-derived from message text;
- `task_status` — the durable task lifecycle (`ready` / `working` / `needs_decision` / `needs_attention` / `archived`);
- `active_execution_id` — the durable execution currently queued or running, if any.

Important semantics:

- the lookup is batched for the task list;
- a newer Work Result durably supersedes older pending decisions;
- live browser execution can outrank an older durable Decision while work is actively running.

This endpoint exists specifically so global Task state remains truthful after reload/restart without making the browser reconstruct durable Decision state from every full Task document.

## Agent Task runtime API (v0.94)

Prefix: `/agent-tasks/{task_id}`

The durable task runtime surface. An Execution is a durable object owned by the Sidecar's background execution supervisor: HTTP clients submit, steer, stop, resume, and OBSERVE — closing a stream never interrupts work.

```text
GET  /agent-tasks/{task_id}/state
POST /agent-tasks/{task_id}/executions
GET  /agent-tasks/{task_id}/executions
GET  /agent-tasks/{task_id}/executions/{execution_id}
GET  /agent-tasks/{task_id}/executions/{execution_id}/events   (SSE)
POST /agent-tasks/{task_id}/executions/{execution_id}/stop
POST /agent-tasks/{task_id}/executions/{execution_id}/resume
POST /agent-tasks/{task_id}/verify
POST /agent-tasks/{task_id}/steer
GET  /agent-tasks/{task_id}/events
GET  /agent-tasks/{task_id}/decisions
POST /agent-tasks/{task_id}/decisions/{decision_id}/resolve
GET  /agent-tasks/{task_id}/work-results
GET  /agent-tasks/{task_id}/artifacts
GET  /agent-tasks/{task_id}/provenance
GET  /agent-tasks/{task_id}/context
GET  /agent-tasks/{task_id}/remediation-plans
GET  /agent-tasks/{task_id}/baselines
GET  /agent-tasks/{task_id}/revisit
PUT  /agent-tasks/{task_id}/revisit
```

- `state` returns everything a client needs to (re)attach after reload, task switch, or Sidecar restart: durable status, active execution + last event sequence, `queued_executions`, `pending_decisions` (each with projected `impact`), context version.
- `POST executions` delegates a Direction. Optional `kind` is `direction` (default), `verify`, or `revisit`. Idempotent on `(task, turn_id)` via a unique index — a duplicate submit attaches (`created: false`) instead of re-running. A submission while another execution runs is QUEUED durably and runs after it.
- `POST .../verify` submits a Verify Execution through that same path when a Remediation Plan exists (`kind=verify`). 404 when the Task has no plan.
- `GET/PUT .../revisit` reads or sets the optional per-task revisit interval. Due revisits are submitted by startup/periodic maintenance (and app-open task-list catch-up) via `runtime.submit(kind=revisit)`, never a second runner. Catch-up Directions are labelled. Confirmation-gated work stays pending.
- The `events` SSE streams the execution's append-only structured event log; every durable frame carries `id: <seq>` and the stream resumes from `?after=<seq>`. Frame vocabulary: `execution.status`, `tool.started`, `tool.completed`, `steer.received`, `steer.applied`, `decision.opened`, `decision.resolved`, `work_result.recorded`, `artifact.recorded`, `context.updated`, `execution.events_truncated`, transient `delta`, terminal `end`. Frontend recovery is this sequence reconnect only.
- `steer` acts ON the current execution: the text is injected into the running model loop at its next tool boundary; a steer the loop could no longer take is carried into an automatic follow-up execution. 409 when nothing is executing.
- `stop` cancels durably; the partial Work Result persists with `stopped: true`.
- `resume` turns an `interrupted` / `failed` / `cancelled` execution into a NEW execution carrying the same Direction (history is never rewritten).
- A Work Result whose proposals include confirmation-gated work leaves its execution `waiting`; `decisions/{id}/resolve` (`approved` | `declined`) records the call durably, settles the waiting execution, and — on approval — returns the same validate-and-prefill hand-over as the action-prepare flow. Nothing auto-executes.
- `context` returns the latest TYPED, versioned Storage Task Context (machine state derived from durable rows — recovery never replays messages). The same snapshot is injected into the Agent prompt's stable half.
- `GET .../provenance` is a **read-only projection** of existing `session_findings`, `tool_calls`, `task_artifacts`, and `runs`. It returns the latest cost / inventory / access-log / drift analysis documents plus per-finding evidence chains (tool, time, coverage, Review target). A missing link is `gap: "no_direct_evidence"` — never a fabricated source. No new tables.

## Health

```text
GET /health
```

Returns Sidecar liveness/service identity. It is intentionally auth-exempt.

## Model providers

Prefix: `/model-providers`

```text
GET    /model-providers
POST   /model-providers
PUT    /model-providers/{provider_id}
DELETE /model-providers/{provider_id}
POST   /model-providers/{provider_id}/activate
POST   /model-providers/{provider_id}/test
```

Secret API keys are accepted on create/update and written to the encrypted local vault. Responses expose metadata/reference/presence state, not plaintext secrets.

Model provider configuration can include optional operator-declared context-window and maximum-output-token limits supported by current persistence/runtime code.

## Cloud providers

Prefix: `/cloud-providers`

```text
GET    /cloud-providers
POST   /cloud-providers
PUT    /cloud-providers/{provider_id}
DELETE /cloud-providers/{provider_id}
POST   /cloud-providers/{provider_id}/test
```

Cloud credentials are vault-backed. Provider bucket/prefix scope is enforced server-side in Agent tools, direct tool endpoints, and deterministic executors.

## Durable Agent Task compatibility API

Prefix: `/sessions`

These paths are the durable task/message/runtime API retained for compatibility. In product code, adapt them to Agent Task semantics.

### Task lifecycle

```text
POST   /sessions
GET    /sessions
GET    /sessions/{session_id}
PATCH  /sessions/{session_id}
DELETE /sessions/{session_id}
POST   /sessions/{session_id}/fork
```

Current behaviors include create/list/detail, rename/pin/archive, deletion, duplication, and branching from a specific message where supplied.

A branch from `from_message_id` includes content through that point and excludes later work. An unknown branch point is an error, not a silent whole-task duplicate.

### Direction / turn execution

```text
POST /sessions/{session_id}/messages
POST /sessions/{session_id}/messages/stream
POST /sessions/{session_id}/turns/{turn_id}/cancel
GET  /sessions/{session_id}/turn
```

Since v0.94 these are compatibility SHIMS over the durable task runtime — there is exactly one submission lifecycle:

- `/messages/stream` submits a durable Execution and streams its event log translated into the legacy `delta`/`tool`/`done`/`error` vocabulary.
- The blocking `/messages` endpoint submits (or attaches to) the same durable execution and waits; idempotency is the durable `(task, turn_id)` unique index.
- `cancel` backs the product Stop control (maps to the durable execution stop).
- `/turn` reads the DURABLE execution rows, so it stays truthful across reloads AND Sidecar restarts; it now also carries `execution_id`/`execution_status` so a client can resume the structured event stream.

Executions survive the HTTP request entirely; after a Sidecar restart, recovery stamps orphaned executions `interrupted` (an explicit durable state with a resume affordance) instead of silently reporting nothing.

### Durable task document and paging

```text
GET /sessions/{session_id}/messages
GET /sessions/{session_id}
```

Task detail returns a recent tail rather than unbounded history. Earlier durable content is fetched through paged `/messages` using `limit` and an opaque `before` cursor.

Do not remove paging merely because the UI calls the object an Agent Task instead of a session. Long-task scalability is a persistence contract.

### Task summary, memory, findings context

```text
GET   /sessions/{session_id}/summary
POST  /sessions/{session_id}/refresh-summary
PATCH /sessions/{session_id}/memory/{id}
POST  /sessions/{session_id}/memory/{id}/resolve
```

Task detail also exposes the durable Agent memory/attachment/context metadata needed by current UI and runtime. Memory edits/resolution are audited and redaction-passed.

### Task Execution links / compatibility runs

```text
POST /sessions/{session_id}/runs/{run_id}
GET  /sessions/{session_id}/runs
```

These link deterministic/auditable executions to a Task. The existence of these endpoints does not make Runs a top-level product destination.

### Task Evidence / Report / action handoff

```text
GET  /sessions/{session_id}/report
POST /sessions/{session_id}/actions/prepare
POST /sessions/{session_id}/datasets/upload
GET  /sessions/{session_id}/error-triage
```

- report generation/fetch produces a durable Markdown Artifact;
- action preparation validates/prefills a proposed next action but does not bypass confirmation or execute hidden work;
- dataset upload attaches local evidence to the Task for bounded local analysis;
- error-triage cases can be associated with the Task.

### Task observability / review data

```text
GET /sessions/{session_id}/activity
GET /sessions/{session_id}/activity/{call_id}
GET /sessions/{session_id}/audit
GET /sessions/{session_id}/overview
```

- `activity` and `audit` are bounded/paged and return truncation metadata;
- `activity/{call_id}` returns one sanitized Tool-call row scoped to the Task/session;
- `overview` provides durable counts and turn-usage/metrics rollups.

Missing provider token usage remains unavailable/NULL, not a fabricated zero.

## Session/Task stream events

`POST /sessions/{id}/messages/stream` emits the real execution stream used by the Agent Task UI.

Event classes include:

- `delta` — streamed Work Result text;
- `tool` — sanitized Tool activity, including started/completed records where available;
- `done` — durable completion metadata such as message id, proposed actions, grounding/evidence/skills and runtime metrics as implemented;
- `error` — sanitized failure;
- stopped/cancelled completion state where applicable.

Persisted message grounding/proposed actions survive reload and are not only transient SSE state.

Tool activity records may carry stable Tool-call ids, exact success state, and measured duration. Older persisted history can legitimately lack fields added by later versions; clients must treat absence as unknown rather than false/zero.

## Deterministic Execution compatibility API

Prefix: `/runs`

```text
GET  /runs
POST /runs
GET  /runs/{run_id}
GET  /runs/{run_id}/account-profile
POST /runs/{run_id}/message
GET  /runs/{run_id}/events
```

`POST /runs` is internal/testing compatibility for deterministic execution, not a user-facing “new run” product flow. Agent-driven deterministic compute and Evidence Import may create/link runs server-side.

### Run SSE

`GET /runs/{run_id}/events` streams deterministic execution events such as:

```text
tool_call_started
tool_call_finished
finding
summary
report_ready
error
```

The deterministic run layer does not contain a second model planner/narrator.

## Reports

```text
GET /reports/{run_id}
```

Fetches a run-associated Markdown report. Task-level Report Review may aggregate broader durable Task context through the session/task report endpoint above.

## Deterministic datasets

```text
POST /runs/{run_id}/datasets/upload
GET  /datasets
GET  /datasets/{dataset_id}
```

Uploads are streamed to disk and bounded by explicit size limits. Dataset metadata includes persisted truncation/ingest-cap truth in current schema.

## Managed Evidence Import

Prefix: `/evidence-imports`

```text
POST /evidence-imports/plan
GET  /evidence-imports/{import_id}
GET  /evidence-imports/{import_id}/files
POST /evidence-imports/{import_id}/confirm
POST /evidence-imports/{import_id}/run
```

This is the durable safety flow for cloud data movement:

> **plan → explicit confirmation → execution**

A plan downloads nothing. Confirmation does not disappear merely because the frontend calls it a Decision. The Sidecar remains authoritative for bounds/state.

## Error triage

```text
POST /error-triage
GET  /error-triage/{case_id}
GET  /sessions/{session_id}/error-triage
```

Supported storage-error triage is deterministic and can operate without a configured model provider.

## Settings

Prefix: `/settings`

Current settings API includes secret-vault health/status endpoints as implemented by the router. It never returns vault plaintext.

```text
GET  /settings/secret-vault
GET  /settings/price-table
PUT  /settings/price-table
```

The price table is ordinary local configuration used by the cost simulator: per-storage-class GB-month rates plus request/retrieval rates. It ships as an example schedule. Dollar simulation remains a gap until `confirmed` is true. The table is not a secret store and must never contain credentials. **Settings UI does not edit it** — if the Agent needs prices it asks in the Task or reports a gap.

There is no product autonomy toggle: read-only Agent investigation is the default capability model, while confirmation-gated operations stop at explicit Decisions.

## Skills

Prefix: `/skills` — additive, same auth, same redaction. Lists bundled + user
skills discovered from `STORAGE_AGENT_DATA_DIR/skills/*/SKILL.md` and
`STORAGE_AGENT_SKILLS_DIR`.

```text
GET  /skills                 — merged catalog (name, description, maturity, path)
GET  /skills/{name}          — frontmatter-stripped SKILL.md body (bounded)
GET  /skills/_dirs/info      — where user skills are discovered (for UI help)
```

User skills shadow bundled ones by name; no code is executed, only guidance
text is returned via `read_skill`.

## Observability export

Bounded, sanitized projection of already-persisted rows — no new tables.

```text
GET  /agent-tasks/{task_id}/export/otel?include_audit=&limit_events=
GET  /observability/export
```

Per-task export includes the durable `execution_events` log (with
`events_truncated`), `tool_calls`, `turn_metrics`, and `task_artifacts`. The
global export lists recent tasks/executions and sanitized provider presence.
All are auth-gated and capped (`MAX_EVENTS=500`, `MAX_TOOL_CALLS=200`).

## MCP bridge (opt-in, read-only)

Disabled by default; set `STORAGE_AGENT_ENABLE_MCP=1` on the Sidecar to
enable. Re-exports the whitelisted read-only storage tools with the same
scope enforcement, bounds, and redaction as the agent. No shell, no raw
boto3, no filesystem escape.

```text
GET  /mcp/status             — enabled flag + allowlist
GET  /mcp/tools              — MCP-style tool definitions for the allowlist
POST /mcp/tools/call         — validated call (allowlist only)
```

When disabled every `/mcp/*` route is 404.

## Direct Tool HTTP endpoints

Prefix: `/tools`

Only the intentionally retained direct endpoints are exposed over HTTP:

```text
POST /tools/head-bucket
POST /tools/list-objects-v2
```

Most Agent tools are in-process runtime tools rather than one HTTP route per capability. Do not expose the entire internal S3 layer as a raw HTTP/tool surface.

## Secret/error-response contract

FastAPI validation and unhandled-error paths are sanitized so request bodies or exception messages cannot echo provider credentials into UI-visible responses.

API code must preserve:

- no plaintext secrets in response payloads;
- no credentials in model context;
- no raw Authorization/cookie/signature leakage;
- Sidecar token handling described above;
- relative/non-sensitive file metadata where possible.

See `security.md`.

## API evolution rule

When adding or changing an endpoint:

1. decide whether it is product-level or compatibility-level;
2. update schemas/router tests;
3. update this document;
4. update `data-model.md` if persistence changes;
5. update `product.md`/`architecture.md` only when product semantics or ownership actually change;
6. never rename product concepts merely to match historical route/table names.
