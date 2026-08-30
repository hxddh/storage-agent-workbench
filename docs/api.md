# Sidecar API

> **Storage Agent v0.93.0 API reference.**
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

The endpoint adapts durable `sessions` rows into product-level Task summaries and adds `requires_decision`, derived from the latest assistant Work Result's current confirmation-gated proposals.

Important semantics:

- the lookup is batched for the task list;
- only the latest assistant result determines current durable Decision state;
- historical confirmation proposals remain history, not current blockers;
- live browser execution can outrank an older durable Decision while work is actively running.

This endpoint exists specifically so global Task state remains truthful after reload/restart without making the browser reconstruct durable Decision state from every full Task document.

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

- `/messages/stream` is the primary SSE turn path.
- The blocking `/messages` endpoint is also the streaming fallback/idempotent wait path for an already-running identical `turn_id`.
- `cancel` backs the product Stop control.
- `/turn` reports whether a real task/session turn is currently running in this Sidecar process, enabling reload reattachment.

The process-local turn registry does not survive a Sidecar restart; reporting no running turn after restart is therefore the truthful state.

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

There is no product autonomy toggle: read-only Agent investigation is the default capability model, while confirmation-gated operations stop at explicit Decisions.

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
