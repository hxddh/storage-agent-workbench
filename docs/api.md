# Sidecar HTTP API

The Sidecar is a local FastAPI service that the desktop shell starts on
`127.0.0.1`. It is the only process that holds secrets, runs the Agent and
talks to storage. This document describes every route it serves.

Sources of truth: `sidecar/app/main.py` and `sidecar/app/api/`
(`tasks.py`, `estate.py`, `providers.py`, `settings.py`, `health.py`,
`mcp.py`).

## Conventions

### Authentication

When the launcher sets `STORAGE_AGENT_AUTH_TOKEN`, every request must present
that token, either as the `X-Sidecar-Token` header or as a `?token=` query
parameter. The query parameter exists for `EventSource`, which cannot set
headers. The comparison is constant-time (`hmac.compare_digest`).

- A missing or wrong token gets `401 {"detail": "unauthorized"}`.
- Exempt: `GET /health` and every `OPTIONS` (CORS preflight) request.
- `GET /health/selfcheck`, the SSE streams and `/mcp` all require the token.
- When `STORAGE_AGENT_AUTH_TOKEN` is unset (dev and tests), no token is
  checked.

### CORS

The allowed origins are:

| Origin | Used by |
| --- | --- |
| `http://localhost:1420`, `http://127.0.0.1:1420` | Tauri dev server |
| `http://localhost:5173`, `http://127.0.0.1:5173` | Vite dev server |
| `tauri://localhost` | Packaged app on macOS |
| `http://tauri.localhost`, `https://tauri.localhost` | Packaged app on Windows (WebView2) |

Allowed methods: `GET POST PUT PATCH DELETE OPTIONS`. All headers are allowed,
and credentials are not. CORS is not the security boundary. The token gate is.

### Errors

| Status | Body | When |
| --- | --- | --- |
| `401` | `{"detail": "unauthorized"}` | Token missing or wrong. |
| `404` / `409` / `413` / `422` | `{"detail": "<message>"}` | Raised by a route (listed per route below). |
| `422` (validation) | `{"detail": [{"type", "loc", "msg", ...}]}` | Pydantic validation failed. Each error's `input` is dropped and `msg` is redacted, so a rejected body never echoes a submitted secret. |
| `500` | `{"detail": "internal error (<ExceptionType>)"}` | Unhandled fault. Only the exception type is returned, never its message. `Access-Control-Allow-Origin` is set when the request came from an allowed origin. |

Timestamps are ISO-8601 UTC strings. IDs are 32-character hex strings.

## Health

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/health` | `{"status": "ok", "service": "storage-agent-sidecar", "version": str, "launch_nonce"?: str}`. `launch_nonce` echoes `STORAGE_AGENT_LAUNCH_NONCE` when it is set. The launcher uses it to confirm it is talking to its own Sidecar. No token is required. |
| `GET` | `/health/selfcheck` | `{"status": "ok" \| "degraded", "service": str, "checks": {"agents_sdk", "s3_client", "analysis_engine", "vault_crypto": "ok" \| "error: <Type>: <redacted, path-scrubbed message>"}}`. The check runs offline: it imports the Agents SDK, builds a boto3 S3 client, round-trips DuckDB, PyArrow and Parquet, and round-trips AES-GCM. |

## Tasks

Router prefix `/tasks`. A Task is a tree of Turns, and the page reads one
branch (see [data-model.md](data-model.md)). Every route that creates work
goes through the runtime (`RUNTIME.submit`). There is no other submit path.

### Request models

| Model | Field | Type and limits |
| --- | --- | --- |
| `TaskIn` | `direction` | `str \| null`, max 16 000 chars |
| | `title` | `str \| null`, max 120 chars |
| | `origin` | `"user"` (default) or `"quick_ask"` |
| `TaskPatch` | `title` | `str`, 1–120 chars |
| `TurnIn` | `direction` | `str`, 1–16 000 chars (required) |
| | `parent_turn_id` | `str \| null`. Omitted or `null`: continue from the head. A turn ID: fork after that turn. `""`: a new first Direction (a fork at the root). |
| | `attachments` | `list[str]` of dataset IDs, max 20 items, default `[]` |
| `SteerIn` | `text` | `str`, 1–16 000 chars |
| `HeadIn` | `turn_id` | `str` |

### The task snapshot

`GET /tasks/{id}`, `POST /tasks` and `PUT /tasks/{id}/head` return the
snapshot of the task's current branch:

```jsonc
{
  "task": { "id", "title", "title_source", "head_turn_id", "origin", "created_at", "updated_at" },
  "state": "working" | "queued" | "needs_attention" | "ready",
  "running_turn_id": "…" | null,
  "queued": [ { "turn_id", "direction", "created_at" } ],
  "turns": [ { "id", "parent_turn_id", "kind", "direction", "status", "error",
               "created_at", "started_at", "finished_at", "resumed_from", "usage" } ],   // the branch, root first
  "items": [ /* public items of those turns, by seq */ ],
  "forks": { "<parent turn id or ''>": ["<child turn id>", …] },   // only parents with more than one child
  "live": { "turn_id", "segment_id", "text" } | null,              // the text segment being streamed now
  "files": [ /* file objects, see Files */ ],
  "artifacts": [ { "id", "kind", "title", "turn_id", "provider_id", "created_at" } ],
  "last_seq": 0                                                   // highest item seq of the task
}
```

- `state` is derived from the task's turns: a running turn gives `working`, a
  queued turn gives `queued`, and a latest turn that is `failed` or
  `interrupted` gives `needs_attention`. Anything else is `ready`.
- `usage` is the turn's recorded usage
  (`{requests, input_tokens, output_tokens, cached_tokens, reasoning_tokens}`)
  or `null`.
- `forks` is built from turns with `kind != 'resume'`. The key `""` stands for
  the root.
- An item is `{seq, id, task_id, turn_id, type, payload, created_at}`.
  `payload.model_output` is removed from every item served over HTTP or SSE.
  That field holds the text the model read; the UI reads `detail` instead.

### Routes

| Method | Path | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET` | `/tasks?q=` | — | `200 {"tasks": [{id, title, title_source, origin, state, created_at, updated_at}]}`. Newest `updated_at` first, at most 500. `q` (max 200 chars) filters titles with `LIKE %q%`. | `422` |
| `POST` | `/tasks` | `TaskIn` | `201` snapshot. Title: `title`, or the first 60 chars of the Direction (whitespace collapsed, `…` appended when cut), or `"New task"`. With a non-empty `direction`, the first turn is submitted at once. Publishes a global `task` event `{task_id, state: "ready", title, created: true}`. | `422` |
| `GET` | `/tasks/{id}` | — | `200` snapshot | `404 task not found` |
| `PATCH` | `/tasks/{id}` | `TaskPatch` | `200` task row. Sets `title_source = 'user'`, writes the audit row `task.rename` and publishes `task {task_id, title}`. | `404`, `422` |
| `DELETE` | `/tasks/{id}` | — | `204`. Stops any running turn, deletes the task (turns, items, artifacts and datasets cascade), removes `<data>/tasks/<id>/`, writes the audit row `task.delete` and publishes `task {task_id, deleted: true}`. | `404` |
| `POST` | `/tasks/{id}/turns` | `TurnIn` | `202 {"turn_id", "status"}`. The Direction is recorded as a `user_message` item at once. The turn waits in the queue behind any running turn. | `404`; `422 unknown parent turn` (the parent is not in this task); `422 unknown attachment for this task` |
| `POST` | `/tasks/{id}/steer` | `SteerIn` | `200 {"steered": bool, "turn_id"}`. With a turn running, the text is recorded as a `steer` item and injected into the running model loop before its next model call (`steered: true`). With nothing running, it becomes a new Direction (`steered: false`, `turn_id` is the new turn). | `404`, `422` |
| `POST` | `/tasks/{id}/stop` | — | `200 {"stopping": bool}`. `false` when nothing is running. Stop sets the turn's cancel flag and cancels the streamed run. The turn ends `cancelled` and keeps what it recorded. | `404` |
| `DELETE` | `/tasks/{id}/turns/{turn_id}` | — | `200 {"cancelled": true}`. Withdraws a queued Direction: status becomes `cancelled`, a `notice {event: "cancelled", queued: true}` is recorded, and the head moves back to the turn's parent when the turn was the head. | `404`; `409 only a queued Direction can be withdrawn` |
| `POST` | `/tasks/{id}/turns/{turn_id}/resume` | — | `202 {"turn_id", "status"}`. Continues an `interrupted`, `failed` or `cancelled` turn as a new `kind = resume` turn whose parent is that turn. | `404`; `409 the task is working`; `409 nothing to resume` |
| `PUT` | `/tasks/{id}/head` | `HeadIn` | `200` snapshot. Moves the head to the newest descendant (`leaf_of`) of `turn_id`, which is how the UI reads another version of a Direction. | `404 task not found`; `404 turn not found` |

### Files

| Method | Path | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST` | `/tasks/{id}/files` | `multipart/form-data`: `file` (required), `dataset_type` = `auto` (default) \| `access_log` \| `inventory` | `201` file object. `auto` decides from the file name and the first 64 KiB. Streamed to disk in 1 MiB chunks. Writes the audit row `file.upload` with detail `{type, bytes}`. | `404`; `422 dataset_type must be auto, access_log or inventory`; `413 file is larger than 2 GiB`; `422` for other save errors |
| `GET` | `/tasks/{id}/files` | — | `200 {"files": [file object]}` | `404` |

A file object is
`{id, origin: "upload" | "import", type, filename, size_bytes, rows, status, bucket, created_at}`.
`rows` is `null` until the file is analyzed. `status` is `ready` or `analyzed`.

### Outputs

| Method | Path | Success | Errors |
| --- | --- | --- | --- |
| `GET` | `/tasks/{id}/artifacts/{artifact_id}` | `200 {id, kind, title, turn_id, provider_id, created_at, payload}` | `404 artifact not found` (also when the artifact belongs to another task) |
| `GET` | `/tasks/{id}/report?lang=en\|zh` | `200 text/plain`: the task report in Markdown, projected from the current branch's items. `lang` defaults to `en`. Only the report's own headings are localized. | `404`; `422` for any other `lang` |
| `GET` | `/tasks/{id}/trace` | `200` OTLP-shaped JSON: `{"resourceSpans": [{"resource": {"attributes": {"service.name": "storage-agent", "storage_agent.task_id"}}, "scopeSpans": [{"scope": {"name": "openai-agents"}, "spans": [{traceId, spanId, parentSpanId, name, kind, startTime, endTime, status: {code: "OK" \| "ERROR", message?}, attributes: {"storage_agent.turn_id", …}}]}]}]}`. Built from the local `spans` table, so it holds names, timings and sizes only. | `404` |

## Live streams (SSE)

Both streams use `sse-starlette` with a comment ping every 15 seconds. An
`EventSource` passes the token as `?token=`.

### `GET /tasks/{id}/events?after=<seq>`

`after` is an integer ≥ 0 and defaults to `0`. An unknown task gets `404`
before the stream opens.

The stream does the following, in order:

1. Subscribes to the task's in-process hub first, then replays, so no item can
   land in the gap between the two.
2. **Replays** the durable items with `seq > after`, as `item` events, in
   `seq` order. The replay query returns at most 2 000 items; any remainder
   arrives through the resync described in step 4.
3. Sends one `live` event: the text segment the model is writing now, or
   `null`.
4. **Follows**: forwards hub events as they happen. Items are de-duplicated
   by `seq`: an item with `seq <= last` is dropped. When a new item arrives
   with the queue otherwise empty, any gap below it is filled from the table
   first. After 10 seconds without an event, the stream replays from the table
   (`items_after(last)`). A follower whose queue overflowed (2 048 events)
   therefore catches up from durable storage.

| Event | `id:` | `data` |
| --- | --- | --- |
| `item` | the item's `seq` | the public item `{seq, id, task_id, turn_id, type, payload, created_at}`, with `payload.model_output` removed |
| `delta` | — | `{turn_id, segment_id, text}`: sanitized live text for the open segment. Deltas are ephemeral. The closed segment later arrives as an `agent_message` item whose `id` equals `segment_id`. |
| `state` | — | `{state, running_turn_id, queued_turn_ids}`, published whenever a turn is queued, starts, finishes or is withdrawn |
| `live` | — | `{turn_id, segment_id, text}` or `null`. Sent once, after the replay. |

The stream is resumable. A client that reconnects with
`after=<last id it saw>` receives exactly the items it missed. `id` values are
global item sequence numbers, so they increase but have gaps within one task.

### `GET /events`

This is the global feed that the sidebar and the tray follow. It has no replay
and no `after` parameter.

| Event | `data` |
| --- | --- |
| `hello` | `{"ok": true}`. Sent once, on connect. |
| `task` | One of:<br>`{task_id, state: "ready", title, created: true}` (task created)<br>`{task_id, state, running_turn_id, queued_turn_ids}` (state change)<br>`{task_id, title}` (renamed by the user or titled by the Agent)<br>`{task_id, deleted: true}` |

## Estate

Router without a prefix. `lang` is optional on every route. A value starting
with `zh` selects Chinese issue titles. Anything else selects English.

| Method | Path | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET` | `/estate` | `lang` | `200` overview: `{providers: [{provider_id, name, provider_type, bucket_count, last_checked_at, open_issues: {high, medium, low}, watch: {…watch, running}}], bucket_count, open_issue_count, issues: [issue] (the 20 most severe needing care), last_watch_at}` | — |
| `GET` | `/issues` | `status` (default `active`), `provider_id`, `limit` 1–500 (default 200), `lang` | `200 [issue]`, ordered high → medium → low → info, then by newest `last_seen_at` | `422 unknown status` |
| `GET` | `/issues/{id}` | `lang` | `200` issue plus `events: [{kind, source, at, detail}]` (newest first, at most 50) | `404 issue not found` |
| `POST` | `/issues/{id}/fix` | `lang` | `200` issue. Generates and stores the deterministic fix text. An `open` or `recurred` issue moves to `fix_proposed`. | `404`; `409 no generated fix for this issue` |
| `GET` | `/issues/{id}/impact` | `lang` | `200 {verdict: "low" \| "caution" \| "unknown", points: [{text, evidence: "access_log" \| "posture" \| "rule", count?, total?}], gaps: [text]}` — what applying the fix would change, from evidence the estate holds (`estate/fixpacks.py`): anonymous requests counted from attached or imported S3 server access logs for the bucket (aggregates only — counts, a time range, at most 3 key prefixes; never a requester, IP or raw line), the recorded lifecycle and versioning posture, and what the change itself does. Only logs already analyzed are read (the preview never ingests); an import must match the issue's provider and bucket, an upload is matched by the bucket named in each line (said in `gaps`); the same log attached twice counts once; unanalyzed or unreadable logs are named in `gaps`. When the evidence cannot answer, `verdict` is `unknown` and `gaps` says why. Reads only local data. | `404`; `409 this issue has no generated fix` |
| `POST` | `/issues/{id}/verify` | `lang` | `200 {"result": "still_present" \| "resolved" \| "inconclusive", "issue"}`. Re-runs the rule's read-only review (`review_bucket_security` or `review_bucket_lifecycle`). The bucket is scope-checked, the call is audited as `tool.review_bucket_<check>` (actor `user`), and the verdict goes through the issue lifecycle (source `verify`). | `404`; `409` with the reason (the storage account is gone, the bucket is out of scope, or the rule has no read-only check) |
| `POST` | `/issues/{id}/accept` | `{"accepted": bool = true, "reason": str ≤ 1000 \| null}`, `lang` | `200` issue. `true` moves an `open`, `fix_proposed` or `recurred` issue to `accepted`; a non-empty `reason` is kept as a note on the bucket (`source = accept`, with the issue id). `false` moves an `accepted` issue back to `open`. Any other combination leaves the status unchanged. | `404`, `422` |
| `GET` | `/estate/providers/{provider_id}/buckets` | — | `200 {buckets: [{bucket, region, last_checked_at, open_issues: {high, medium, low}}], notes: [note]}` — the account's known buckets, most in need of care first (≤ 500), and its account-level notes. | `404 cloud provider not found` |
| `GET` | `/estate/providers/{provider_id}/buckets/{bucket}` | `lang` | `200` bucket page: `{provider_id, bucket, region, posture, last_checked_at, source_task_id, issues: [issue] (every status), timeline: [entry] (newest first, ≤ 200), notes: [note]}`. A timeline entry is `{kind: "posture", at, source, task_id, first, changed: [key], posture}` (the first observation, then each change of the posture projection) or `{kind: "issue", at, source, event, issue_id, code, title, severity}` (an `issue_events` row). | `404` (provider, or a bucket the estate does not know) |

`status` for `GET /issues` accepts `active` (open, fix_proposed, recurred,
accepted), `care` (open, fix_proposed, recurred), `all`, or one status:
`open`, `fix_proposed`, `resolved`, `recurred`, `accepted`.

An **issue** is:

```jsonc
{ "id", "provider_id", "provider_name", "bucket", "code", "title", "severity", "status", "detail",
  "first_seen_at", "last_seen_at", "resolved_at", "resolved_by",
  "source_task_id",            // null when that task no longer exists
  "fix": { "kind", "document", "command", "notes": [],
           "formats": [{ "format": "cli" | "terraform" | "json", "label", "text" }] } | null,
  "fixable": bool,             // a deterministic fix exists for this code
  "last_verified_at", "last_verify_result" }
```

No estate route writes to storage. A fix is text for the user to apply: the
bucket name, endpoint and region are shell-quoted in the CLI command and
HCL-escaped in the Terraform resource, so a hostile listing cannot inject a
second command. A bucket name outside `[A-Za-z0-9._-]` gets no generated fix at all (`fixable: false`), because no quoting is safe in every shell. The `fix` served is always regenerated from the rule and the provider's current endpoint; stored text is never served.

### Notes

| Method | Path | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET` | `/notes` | `provider_id`, `bucket` | `200 [note]`, newest first (≤ 200) | — |
| `POST` | `/notes` | `{"text": 1–1000 chars, "provider_id": str \| null, "bucket": str ≤ 255 \| null}` | `201` note (`source = user`) | `422` (no text, a bucket without a provider, an unknown provider) |
| `PATCH` | `/notes/{id}` | `{"text": 1–1000 chars}` | `200` note | `404`, `422` |
| `DELETE` | `/notes/{id}` | — | `204` | `404` |

A **note** is `{id, provider_id, bucket, text, source: "user" | "agent" | "accept", task_id, issue_id, created_at, updated_at}`.
Text is redacted (secret-shaped tokens are masked even without an access-key
hint). At most 500 notes are kept (oldest first out). Every add, edit and
delete writes an audit row (`note.add`, `note.edit`, `note.delete`). The 12
most recent reach every turn as an `estate_notes` block inside the untrusted-data envelope — remembered context, never instructions. `GET /notes?exact=true` lists only that scope's own notes (no scope: the estate-wide ones). The oldest Agent notes are trimmed first (audit `note.trim`); un-accepting an issue deletes its accept-reason notes.

### Watch

A watch is opt-in per storage account and is off by default.

| Method | Path | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET` | `/estate/watch/{provider_id}` | — | `200 {enabled, interval_hours, next_run_at, last_run_at, last_status, last_summary, last_task_id, running}`. Defaults when never set: disabled, 24 h. | `404 cloud provider not found` |
| `PUT` | `/estate/watch/{provider_id}` | `{"enabled": bool, "interval_hours": int = 24}` | `200` watch object. `interval_hours` is clamped to 1–168. Enabling makes the watch due now, unless it was already enabled with a pending `next_run_at`. Disabling clears `next_run_at`. Writes the audit row `watch.set`. | `404`, `422` |
| `POST` | `/estate/watch/{provider_id}/run` | — | `202 {"started": bool}`. Starts one background sweep now, even when the watch is off. `false` when a sweep for this provider is already running. | `404` |

The Sidecar's clock (`STORAGE_AGENT_WATCH_TICK_SECONDS`, default 60, minimum
5) runs due sweeps. A sweep surveys up to 500 buckets, then re-checks up to 25
buckets whose active issues posture cannot decide. It opens one Agent Task
(`origin = watch`, turn `kind = watch`) through `RUNTIME.submit` only when a
high or medium issue opened or recurred and a model is configured. A scheduled
sweep stops between phases once its watch is turned off. `last_status` is one
of `running`, `found`, `clear` or `failed`.

## Providers

Router prefix `/providers`. Secrets go in and never come out: responses carry
`has_*` booleans only.

### Model endpoints

| Method | Path | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET` | `/providers/models` | — | `200 [model provider]`, oldest first | — |
| `POST` | `/providers/models` | `ModelProviderIn` | `201` model provider. Audit row `model_provider.create`. | `422` |
| `PATCH` | `/providers/models/{id}` | `ModelProviderPatch` | `200` model provider. Audit row `model_provider.update`. | `404 model provider not found`, `422` |
| `DELETE` | `/providers/models/{id}` | — | `204`. Also deletes the vault secret. Audit row `model_provider.delete`. | `404` |
| `POST` | `/providers/models/{id}/activate` | — | `200` model provider. Exactly one provider is active. | `404` |
| `POST` | `/providers/models/{id}/test` | — | `200 {"ok": bool, "api_key_verified": bool \| null, "detail": str}`. Sends one `GET {base_url}/models` with a 5-second timeout; the response body is never echoed. `401`/`403` → `ok: false, api_key_verified: false`. `5xx` or a network error → `ok: false`. `200` → `ok: true, api_key_verified: true`. Any other status → `ok: true, api_key_verified: null`. A non-failing result also clears remembered endpoint refusals (parallel tool calls, streamed usage). A missing key → `ok: false` with the reason. | `404` |

`ModelProviderIn`:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `str`, 1–120 | required |
| `kind` | `openai` (default) \| `anthropic` \| `deepseek` \| `openrouter` \| `ollama` \| `lmstudio` \| `vllm` \| `llamacpp` \| `openai-compatible` | |
| `base_url` | `str \| null` | Default per kind (local kinds use localhost). `openai` with no URL uses the official endpoint. |
| `model` | `str`, 1–200 | required |
| `api_key` | `str \| null` | Stored in the vault. Local kinds work without one. |
| `api_style` | `responses` \| `chat` \| `null` | Default: `responses` only for `kind = openai` on `api.openai.com` (or no base URL). Otherwise `chat`. |
| `context_window` | `int ≥ 0 \| null` | `0` or `null`: derived from the model name |
| `max_output_tokens` | `int ≥ 0 \| null` | |
| `reasoning_effort` | `low` \| `medium` \| `high` \| `""` \| `null` | Sent only to models recognized as reasoning models. |

`ModelProviderPatch` has the same fields, all optional. A field that is left
out or `null` keeps its value. `""` or `0` clears it. A non-empty `api_key`
replaces the stored key; a key cannot be cleared through PATCH. When `kind` or
`base_url` changes and `api_style` is not given, the style is derived again.

A model provider is:
`{id, name, kind, base_url, model, api_style, has_api_key, context_window, max_output_tokens, reasoning_effort, reasoning_capable, active, created_at, updated_at}`.

### Storage accounts

| Method | Path | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET` | `/providers/clouds` | — | `200 [cloud provider + {"watch": {…watch, running}}]`, oldest first | — |
| `POST` | `/providers/clouds` | `CloudIn` | `201` cloud provider. Audit row `cloud_provider.create`. | `422` |
| `PATCH` | `/providers/clouds/{id}` | `CloudPatch` | `200` cloud provider. Invalidates cached S3 clients. Audit row `cloud_provider.update`. | `404 cloud provider not found`, `422` |
| `DELETE` | `/providers/clouds/{id}` | — | `204`. Deletes the vault secrets. The account's estate buckets, issues and watch cascade. Audit row `cloud_provider.delete`. | `404` |
| `POST` | `/providers/clouds/{id}/test` | — | `200`: the redacted result of the read-only `test_credentials` engine call, audited as `tool.test_credentials` with actor `user` (see `run_direct` in [tools.md](tools.md)) | `404` |

`CloudIn`: `name` (1–120, required), `provider_type` (1–40, required),
`endpoint_url`, `region`, `addressing_style` (default `"virtual"`),
`signature_version` (default `"s3v4"`), `access_key`, `secret_key`,
`session_token` (all stored in the vault), `allowed_buckets: list[str]`,
`allowed_prefixes: list[str]` (both default `[]`, which means unrestricted).

`CloudPatch` has the same fields, all optional. `null` keeps a field. `""`
clears `endpoint_url`, `region`, `addressing_style` or `signature_version`.
A non-empty secret replaces the stored one. `session_token: ""` deletes the
session token. A list replaces the scope list.

A cloud provider is:
`{id, name, provider_type, endpoint_url, region, addressing_style, signature_version, allowed_buckets, allowed_prefixes, has_access_key, has_secret_key, has_session_token, created_at, updated_at}`.

## Settings

| Method | Path | Body | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET` | `/settings` | — | `200 {language: "en" \| "zh", theme: "system" \| "light" \| "dark", vault: {unreadable, backup_present}, instructions: {loaded, path, chars, truncated, error}}`. `instructions` reports on the standing instructions file (`AGENTS.md`) but never returns its text. | — |
| `PATCH` | `/settings` | `{language?: str, theme?: str}` | `200`, the same shape as `GET` | `422 <key> must be one of …` |
| `GET` | `/settings/price-table` | — | `200 {id: "default", confirmed, example, note, rates, updated_at}`. Returns the example schedule (`confirmed: false`, `example: true`) until the user saves a table. | — |
| `PUT` | `/settings/price-table` | `{confirmed?: bool, rates?: object, note?: str (≤ 800)}` | `200` price table. Omitted fields keep their value. Audit row `settings.price_table`. | `422` |
| `GET` | `/skills` | — | `200 {skills: [{name, description, domains, user}], dirs: [str]}`. `user` is true for a user-supplied skill. `dirs` are the user skill directories. | — |
| `GET` | `/skills/{name}` | — | `200 {name, body}` | `400 invalid skill name` (the name must match `^[a-zA-Z][a-zA-Z0-9_-]{1,64}$`); `404 skill not found` |

## MCP server

An opt-in, read-only MCP server. It exists only when the Sidecar starts with
`STORAGE_AGENT_ENABLE_MCP=1`.

- It is built with the official MCP Python SDK (`mcp.server.mcpserver.MCPServer`,
  named `storage-agent`) and served over **Streamable HTTP**, **stateless**,
  with **JSON responses** (not SSE). It is mounted at `/mcp`. The endpoint is
  `/mcp/`, and a request to `/mcp` redirects there with `307`.
- The token gate applies, as it does to every route. The SDK's transport also
  rejects requests whose `Host` is not local with `421`.
- The session manager runs inside the Sidecar's lifespan.

The server exposes `list_providers` plus a subset of the Agent's tool registry
(`exposed()` in `sidecar/app/api/mcp.py`):

- every tool in the `probes`, `objects` and `config` groups, except
  `review_bucket_config` (that tool saves a task artifact);
- plus `list_buckets`, `head_bucket`, `read_skill`, `query_estate` and
  `triage_error`.

`list_providers` returns
`[{id, name, provider_type, region, allowed_buckets, allowed_prefixes}]` and
never returns credentials. It is annotated read-only and closed-world. Every
other tool is annotated `readOnlyHint = true`, `destructiveHint = false`,
`openWorldHint = true`.

The 31 exposed tools are: `list_providers`, `diagnose_presigned_url`,
`get_bucket_config_detail`, `get_bucket_config_summary`,
`get_bucket_location`, `get_object_acl`, `get_object_attributes`,
`get_object_lock_status`, `get_object_tagging`, `head_bucket`, `head_object`,
`inspect_endpoint_tls`, `list_buckets`, `list_multipart_uploads`,
`list_object_versions`, `list_objects`, `list_upload_parts`,
`measure_request_latency`, `preview_object`, `query_estate`, `read_skill`,
`review_bucket_cost_optimization`, `review_bucket_lifecycle`,
`review_bucket_observability`, `review_bucket_performance_profile`,
`review_bucket_security`, `test_addressing_style`, `test_conditional_get`,
`test_credentials`, `test_range_get`, `triage_error`.

Each registry tool runs through `registry.call_direct(..., actor="mcp")`. It
gets the same argument clamping, scope check and redaction as inside a turn,
and one audit row with actor `mcp` (a refusal is audited with `ok = 0`). Tools
that belong to a task (surveys, files, imports, the conclusion) are not
exposed.
