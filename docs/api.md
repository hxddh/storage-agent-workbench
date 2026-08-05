# API

The sidecar binds localhost on a port chosen at launch. In the packaged app the
Tauri shell starts it on a free port and exposes the URL to the frontend; in dev
it defaults to `http://127.0.0.1:8765` (override with `VITE_SIDECAR_URL`). Paths
below are relative to that base.

This lists the real routers under `sidecar/app/routers/`. Method + path + a
one-line purpose; request/response schemas live in `sidecar/app/models/schemas.py`.

## Authentication

The sidecar enforces a shared-secret gate when the launcher sets
`STORAGE_AGENT_AUTH_TOKEN` (the Tauri shell generates a random per-launch token,
spawns the sidecar with it, and exposes it to the frontend via the
`get_sidecar_token` command). When set, every request must carry the token or it
gets `401 {"detail": "unauthorized"}`:

- `X-Sidecar-Token: <token>` header (normal requests), or
- `?token=<token>` query param (for the header-less SSE `EventSource`).

Exempt: `GET /health` (liveness) and `OPTIONS` (CORS preflight). Comparison is
constant-time, and the packaged sidecar disables uvicorn access logging so the
`?token=` param never lands in logs. When the variable is unset (dev runs, the
test suite) auth is open.

## Health

### GET /health

Liveness probe.

```json
{
  "status": "ok",
  "service": "storage-agent-sidecar"
}
```

## Model providers

Router prefix `/model-providers` (`routers/model_providers.py`).

```text
GET    /model-providers               # list configured model providers (each has `active`)
POST   /model-providers               # create a model provider (api key stored as a keyring:// ref)
PUT    /model-providers/{provider_id} # update a model provider
DELETE /model-providers/{provider_id} # delete a model provider (clears the active selection if it pointed here)
POST   /model-providers/{provider_id}/activate  # select the provider the agent uses (else oldest is the default)
POST   /model-providers/{provider_id}/test      # validate the provider (a bounded model call)
```

## Cloud providers

Router prefix `/cloud-providers` (`routers/cloud_providers.py`).

```text
GET    /cloud-providers               # list configured cloud (S3-compatible) providers
POST   /cloud-providers               # create a cloud provider (access/secret/token stored as keyring:// refs)
PUT    /cloud-providers/{provider_id} # update a cloud provider
DELETE /cloud-providers/{provider_id} # delete a cloud provider
POST   /cloud-providers/{provider_id}/test  # read-only credential/connectivity check
```

## Runs

Router prefix `/runs` (`routers/runs.py`).

```text
GET  /runs                        # list run summaries
POST /runs                        # INTERNAL / testing — create a deterministic run directly (not a user surface)
GET  /runs/{run_id}               # run detail (status, tool calls, findings, summary)
GET  /runs/{run_id}/account-profile  # structured account-discovery result (bucket table + evidence sources)
POST /runs/{run_id}/message       # append a message to a run
GET  /runs/{run_id}/events        # SSE stream of the run's live events
```

`POST /runs` creates a deterministic run directly. Per the `runs` router
docstring it is **internal / testing only** — the frontend never calls it (the
conversational agent drives runs via `run_service`, and evidence import creates
its run server-side). It stays because the deterministic run layer is the
reproducibility / security floor and the test suite creates runs through it; it
is not wired into the UI as a "new run" form.

## Reports

Router (no prefix) `routers/reports.py`.

```text
GET /reports/{run_id}             # fetch a generated run report (markdown)
```

## Datasets

Router (no prefix) `routers/datasets.py`.

```text
POST /runs/{run_id}/datasets/upload   # attach a data file to a run for deterministic analysis
GET  /datasets                        # list dataset metadata
GET  /datasets/{dataset_id}           # dataset metadata detail
```

Uploads are streamed to disk (never buffered whole in memory) and rejected with
`413` over an explicit max-size cap — same for the session attachment upload
below.

## Evidence imports

Router prefix `/evidence-imports` (`routers/evidence_imports.py`). The
confirmation-gated import of cloud evidence (inventory / access logs) discovered
by account discovery: plan → confirm → run.

```text
POST /evidence-imports/plan                 # build a bounded, unconfirmed import plan
GET  /evidence-imports/{import_id}          # import record (plan + status)
GET  /evidence-imports/{import_id}/files    # selected/planned files for the import
POST /evidence-imports/{import_id}/confirm  # confirm the plan (the data-moving gate)
POST /evidence-imports/{import_id}/run      # execute a confirmed import into a local analysis run
```

## Sessions

Router prefix `/sessions` (`routers/sessions.py`). The thread-first surface.

```text
POST   /sessions                            # create an investigation session
GET    /sessions                            # list session summaries
GET    /sessions/{session_id}               # session detail
PATCH  /sessions/{session_id}               # rename / pin / archive
DELETE /sessions/{session_id}               # delete a session (cascades)
POST   /sessions/{session_id}/fork          # duplicate a session (thread, memory, datasets)
POST   /sessions/{session_id}/runs/{run_id} # link an existing run to a session
GET    /sessions/{session_id}/runs          # runs linked to the session
GET    /sessions/{session_id}/summary       # deterministic session summary
POST   /sessions/{session_id}/refresh-summary  # rebuild the summary from run artifacts
GET    /sessions/{session_id}/report        # generate/fetch the session report (markdown)
POST   /sessions/{session_id}/actions/prepare  # prepare a proposed next action for execution
GET    /sessions/{session_id}/messages      # thread messages, PAGED (limit + before → total/has_more)
POST   /sessions/{session_id}/datasets/upload  # attach a data file to the session for agent-native analysis (413 over the size cap)
POST   /sessions/{session_id}/messages      # send a message (blocking agent turn / streaming fallback)
POST   /sessions/{session_id}/messages/stream  # send a message (SSE-streamed agent turn)
POST   /sessions/{session_id}/turns/{turn_id}/cancel  # cancel a streaming turn (Stop button)
GET    /sessions/{session_id}/activity      # the session's tool calls (sanitized input/output + duration)
GET    /sessions/{session_id}/audit         # the session's audit trail (rule 17)
GET    /sessions/{session_id}/overview      # counts, token rollup, and per-turn metrics
GET    /sessions/{session_id}/turn          # is a turn running right now? (reattach after a reload)
PATCH  /sessions/{session_id}/memory/{id}   # correct one of the agent's memory items
POST   /sessions/{session_id}/memory/{id}/resolve  # close a memory item (stops being replayed)
```

Paging (v0.47.0): `GET /sessions/{id}` returns the **tail** of the thread
(60 messages) plus `message_total`; `GET /sessions/{id}/messages` takes `limit`
and `before` (an opaque `seq` cursor from the oldest message the client holds)
and returns `total` + `has_more`. A long investigation used to re-send its whole
history on every open and every turn — ~1 MiB of JSON at 300 turns, growing
without bound. `GET /sessions/{id}/report` is the one caller that reads the
thread unbounded, because the report covers the entire investigation; it bounds
the document for reading and states when it truncates.

Token detail (v0.53.0): `/overview`'s `usage` and each `turn_metrics` row also
carry `cached_input_tokens` and `reasoning_tokens`, taken straight from the SDK's
`Usage` details. Both are **null when the endpoint did not report them** — not
zero. The fixed prompt prefix (instructions + tool schemas, ~5k tokens) is
re-sent on every step of a multi-step turn, so the cache hit rate is the single
biggest factor in what a turn costs; a confident `0` would claim a cold cache we
never measured. A genuine `0` IS stored, because a cold cache is the finding
worth acting on.

Turn budget (v0.54.0): each `turn_metrics` row also carries `budget_tokens` (the
per-turn token ceiling that turn ran under) and `repeat_calls_avoided` (identical
`(tool, args)` calls answered from the conversation instead of re-run). The
`done` SSE event carries the same two under `metrics`, plus `budget_stopped_on`
(`"tokens"` / `"chars"`) when a bound is what ended the investigation. These are
the workbench's **own** governor, not provider measurements — they sit beside
`usage`, never inside it, and every one of them is omitted rather than zeroed
when there is nothing to report.

Tool activity (v0.55.0): every record on the `tool` SSE event and on a persisted
message's `tool_activity` carries `id` — the SAME id as its `tool_calls` row, so
a thread row resolves to its real sanitized input/output instead of being matched
by time window — plus `ok` (the sidecar's exact success verdict, not a guess at
the result text) and `duration_ms` (measured since v0.45.0, sent since this
release). Records replayed from older history carry none of the three; a client
must treat them as absent rather than false/zero.

Observability (v0.45.0): `/activity` and `/audit` are bounded — `limit` is capped
at 500 (default 200) and every response carries `total` / `offset` / `limit` /
`truncated`, so a partial timeline is never presented as a complete one. They
read rows that were sanitized on write; nothing is re-derived. `/overview`
returns `usage.available` — **false** means the model endpoint never reported
token counts, which the UI must render as "not reported", not as zero. When only
some turns reported, `usage.partial` is true and the totals are a floor.

What the agent knows (v0.51.0): `GET /sessions/{id}` also returns `agent_memory`
(the facts / findings / open questions the agent recorded itself and replays
into EVERY later turn), `attached_files` (without their filesystem paths — the
app data dir carries the OS username), and `context_messages` (how many of
`message_total` the agent actually replays, so the UI can say when the earliest
turns have rolled out of its view). `agent_memory` is the same tail-capped list
the agent replays, so the panel shows exactly what is in its context; the report
fetches more and states what it left out.

`PATCH /memory/{id}` and `POST /memory/{id}/resolve` are the user's half of the
`update_memory_item` / `resolve_memory_item` tools the agent already had. Text is
redacted by the repository on write, exactly like the agent's own writes, and
both are audited as `session.memory_edit` / `session.memory_resolve` with
`by: user` (rule 17) — so a later reader can tell which premises the agent
derived and which a human overrode. Resolve closes rather than deletes.

Reattach (v0.51.0): `GET /sessions/{id}/turn` reports `{running, turn_id,
started_at, age_ms}`. Client run state lives in memory, so reloading the app
mid-turn showed an idle session while the worker kept generating and spending.
Process-local like `turn_guard` itself: after a sidecar restart nothing is
running, and saying so is the truth.

Turn semantics: the client sends a `turn_id` with each turn. The blocking
`POST /messages` doubles as the streaming fallback — if an identical `turn_id`
is already in flight it **waits** for that turn instead of re-running the agent,
and returns `409 "turn still in progress"` after ~150 s if it hasn't finished.
`POST /turns/{turn_id}/cancel` returns `200 {"status": "cancelling"}` (or
`"completed"` if the turn already finished) and `404` for an unknown turn; the
partial answer is persisted with a stopped marker.

## Error triage

Router (no prefix) `routers/error_triage.py`. Offline, deterministic S3 /
object-storage error triage (no credentials required).

```text
POST /error-triage                        # parse + triage a pasted error, returns findings + next checks
GET  /error-triage/{case_id}              # a triage case (findings + deterministic next-check proposals)
GET  /sessions/{session_id}/error-triage  # triage cases for a session
```

## Settings

Router prefix `/settings` (`routers/settings.py`). There is no autonomy toggle;
secrets are never stored or served here.

```text
GET /settings/secret-vault   # whether the encrypted secret vault failed to decrypt this session
```

## Tools

Router prefix `/tools` (`routers/tools.py`). Direct, typed, whitelisted
read-only S3 tool endpoints (used by tests and internal callers). Only two
survive — the rest of the old `/tools/*` endpoints were deleted; their
underlying S3-layer functions remain available to the agent as in-process tools,
just not as HTTP routes.

```text
POST /tools/head-bucket
POST /tools/list-objects-v2
```

Both enforce the provider's `allowed_buckets` / `allowed_prefixes` scope (as do
the run executors and the agent session tools).

## Run SSE event types

`GET /runs/{run_id}/events` streams the run's live timeline. Runs are pure
deterministic compute (no LLM planner); the executors under `sidecar/app/runs/`
publish only these event types (verified against `bus.publish(...)` calls and
the in-memory `events.py` bus):

```json
{"type":"tool_call_started","tool_name":"head_bucket","tool_call_id":"..."}
{"type":"tool_call_finished","tool_name":"head_bucket","status":"success","output":{}}
{"type":"finding","severity":"warning","title":"...","detail":"..."}
{"type":"summary","content":"..."}
{"type":"report_ready","run_id":"...","report_path":"..."}
{"type":"error","message":"..."}
```

The stream also sends `: keepalive` SSE comments during long silences. There are
no `run_started`, `guardrail_passed`, `guardrail_blocked`, or `final_summary`
events — those were removed and are not emitted.

## Session message stream

`POST /sessions/{id}/messages/stream` emits `delta` (answer text), `tool` (a
sanitized `{tool, target, result}` trace — a tool may first appear as a
`"status": "started"` record, the live tool-start signal, before its completed
record), and a final `done`
(`{message_id, proposed_actions, evidence_used, evidence_gaps, skills_used}`) —
or `error`. A cancelled turn's `done` event may carry `"stopped": true`. The
three grounding fields mirror the blocking `POST /sessions/{id}/messages`
response and are also persisted on the message row (see `docs/data-model.md`).
