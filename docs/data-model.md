# Data model

Storage Agent keeps its durable state in one SQLite database plus per-task
files on disk. Secrets are not stored in either place: they live in the
encrypted vault (`security/keyring_store`), and SQLite holds only
`keyring://…` references to them.

Sources of truth: `sidecar/app/migrations.py`, `sidecar/app/config.py`,
`sidecar/app/core/store.py`, `sidecar/app/agent/recorder.py`,
`sidecar/app/agent/runtime.py`, `sidecar/app/estate/`,
`sidecar/app/engines/datasets.py`, `sidecar/app/agent/tracing.py` and
`sidecar/app/importer.py`.

## Files and locations

| What | Where |
| --- | --- |
| Data directory | `STORAGE_AGENT_DATA_DIR`, else `SAW_DATA_DIR`, else `<repo>/data`. Resolved to an absolute path and tightened to `0700` on POSIX. |
| Database | `<data>/storage-agent.db`, or `SAW_DB_PATH` when set. WAL mode, `foreign_keys = ON`. Created with mode `0600` on POSIX. |
| v4 database (read only) | `<data>/app.db`. See [Import from v4](#import-from-v4). |
| Per-task files | `<data>/tasks/<task_id>/`. Removed when the task is deleted. |

## Migrations

`sidecar/app/migrations.py` holds an ordered list of `(version, name, sql)`
entries. The head is **2**:

| Version | Name |
| --- | --- |
| 1 | `v5_items_estate` |
| 2 | `v6_notes_posture_history` — `notes`, `posture_history`, `idx_issues_bucket` |

`apply_migrations` creates `schema_migrations (version INTEGER PRIMARY KEY,
name TEXT NOT NULL, applied_at TEXT NOT NULL)` if it is missing. It then runs
each pending migration as one script inside `BEGIN … COMMIT`, together with
its `schema_migrations` row, and rolls back on error.

**Migrations are append-only. Never edit a migration that has shipped; add a
new entry with the next version number.**

## Core model

A **Task** is a tree of **Turns**. A turn is one Direction and the work it
caused. Everything that happened in a turn is an ordered, append-only stream
of **Items**. The task page, the report, the audit view and the trace export
are all projections of items and their side tables.

### `tasks`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | hex UUID |
| `title` | TEXT NOT NULL | at most 120 chars |
| `title_source` | TEXT NOT NULL, default `'seed'` | `seed` (from the first Direction), `agent` (the title step after the first answer) or `user` (a rename; a user rename is never overwritten) |
| `head_turn_id` | TEXT | the turn the task currently continues from, which is the tip of the branch being read |
| `origin` | TEXT NOT NULL, default `'user'` | `user`, `watch` (opened by a watch sweep) or `quick_ask` |
| `created_at`, `updated_at` | TEXT NOT NULL | |

A task's **state** is not stored. It is derived from the task's turns
(`store.task_state`):

| State | Condition |
| --- | --- |
| `working` | a turn is `running` |
| `queued` | no turn is running, and a turn is `queued` |
| `needs_attention` | the latest turn is `failed` or `interrupted` |
| `ready` | anything else |

### `turns`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | |
| `task_id` | TEXT NOT NULL → `tasks(id)` ON DELETE CASCADE | |
| `parent_turn_id` | TEXT → `turns(id)` ON DELETE SET NULL | The previous turn on this branch. `NULL` for a root turn. |
| `kind` | TEXT NOT NULL, default `'direction'` | `direction`, `resume` or `watch` |
| `direction` | TEXT NOT NULL | the Direction text (a resume turn repeats the Direction of the turn it continues) |
| `status` | TEXT NOT NULL | `queued`, `running`, `completed`, `failed`, `cancelled` or `interrupted` |
| `error` | TEXT | user-readable, at most 2 000 chars |
| `usage_json` | TEXT | `{requests, input_tokens, output_tokens, cached_tokens, reasoning_tokens}` |
| `resumed_from` | TEXT | for `resume` turns: the turn being continued |
| `created_at` | TEXT NOT NULL | |
| `started_at` | TEXT | set once, when the turn first goes `running` |
| `finished_at` | TEXT | set when the turn reaches `completed`, `failed`, `cancelled` or `interrupted` |

Indexes: `idx_turns_task (task_id, created_at)` and `idx_turns_status (status)`.

**Turn kinds**

| Kind | Created by |
| --- | --- |
| `direction` | `POST /tasks`, `POST /tasks/{id}/turns`, or a steer while nothing runs |
| `resume` | Restart recovery, or `POST /tasks/{id}/turns/{turn_id}/resume`. Its parent is the turn it continues. Its first item is a `notice {event: "resumed"}`, not a `user_message`. |
| `watch` | A watch sweep that found new high or medium issues |

**Turn lifecycle.** A submitted turn is `queued`, and its Direction is
recorded at once. Each task has one worker that runs its queued turns one at a
time, oldest first. A running turn ends in one of these states:

- `completed`: finished normally, or recovered from a step-budget, provider
  or overflow failure by one tool-less "finalize" call.
- `failed`: no usable model, or an unrecoverable error.
- `cancelled`: stopped by the user, or withdrawn while it was still queued.

At startup, turns still marked `running` are set to `interrupted`. Each one
that is not itself a `resume` turn is continued once by a new `resume` turn,
provided a model is configured. Queued turns are picked up again.

### A task as a tree of turns

- **Continue.** A new turn with no explicit parent takes the task's
  `head_turn_id` as its parent, and the head moves to the new turn.
- **Fork.** A new turn with an explicit `parent_turn_id` becomes a sibling
  branch under that parent, and the head moves to it. `parent_turn_id = ""`
  forks at the root (a new first Direction).
- **Branch** (`store.branch`). The chain from a head (the task's head by
  default) back to the root, oldest first. The page, the report and the
  model's history all read one branch.
- **Siblings** (`store.siblings`). For each parent (key `""` for the root),
  its child turns in creation order, excluding `resume` turns. A parent with
  more than one child is a fork point. The snapshot's `forks` field lists
  those.
- **Leaf** (`store.leaf_of`). From a turn, follows the newest child at each
  level down to a leaf. Switching to another version (`PUT /tasks/{id}/head`)
  sets the head to that leaf.
- **Withdrawing** a queued head turn moves the head back to its parent.

### `items`

| Column | Type | Notes |
| --- | --- | --- |
| `seq` | INTEGER PK AUTOINCREMENT | Global and monotonic across all tasks. Every follower resumes by it. |
| `id` | TEXT NOT NULL UNIQUE | For a closed `agent_message`, this is the live segment ID used by `delta` events. |
| `task_id` | TEXT NOT NULL → `tasks(id)` ON DELETE CASCADE | |
| `turn_id` | TEXT → `turns(id)` ON DELETE CASCADE | |
| `type` | TEXT NOT NULL | one of the item types below |
| `payload` | TEXT NOT NULL | JSON. Payloads longer than 400 000 chars are replaced by `{"truncated": true, "chars", "head"}`. |
| `created_at` | TEXT NOT NULL | |

Indexes: `idx_items_task (task_id, seq)` and `idx_items_turn (turn_id, seq)`.

Items are append-only. Live model text is not stored as it streams: it goes
to the in-process hub as `delta` events, and is written once, whole and
sanitized, when its segment closes. All writes during a turn go through the
turn's `Recorder`, which also publishes each item to open streams.

#### Item types and payloads

| Type | Payload | Written when |
| --- | --- | --- |
| `user_message` | `{text, attachments?: [{dataset_id, filename, type}]}` | A Direction is submitted. The text is redacted. |
| `agent_message` | `{text}` | A model text segment closes: at a tool call, at a new message, or at the end of the turn. Commentary and the final answer are both agent messages. Also written by the finalize step. The text passes through the chain-of-thought and secret filters. |
| `tool_call` | `{call_id, name, args, target}` | A tool starts. `args` are clamped and redacted. `target` is `bucket/key`, `bucket`, `name`, `dataset_id` or `provider_id`. |
| `tool_progress` | `{call_id, name, done, total, unit}` | An engine reports counts (survey buckets, import files). Throttled to at most one per second and 120 per call. The final count (`done >= total`) is always written. `unit` is at most 24 chars. |
| `tool_output` | `{call_id, name, ok, summary, duration_ms, detail, detail_truncated, model_output}` | A tool finishes. `summary` is at most 240 chars. `detail` is the redacted result as JSON, at most 24 000 chars, and is what the UI reads. `model_output` is the same, at most 60 000 chars, is removed from every HTTP/SSE response, and is replayed to the model as the call's output in later history. A call stopped before it ran, or cancelled or timed out, has `ok: false`, a `summary` saying so, and `detail` and `model_output` set to `null`. |
| `tool_output` (refused) | `{call_id, name, ok: false, refused: true, summary, model_output}` | The scope guardrail rejected the call. A `tool_call` item precedes it. |
| `conclusion` | `{call_id, answer, findings: [{title, severity, detail?}], next_steps}` | The model called `record_conclusion` with valid arguments. `answer` ≤ 400 chars; ≤ 8 findings (title ≤ 240, severity `high`/`medium`/`low`/`info`, detail ≤ 600); ≤ 4 next steps, each cut to 200 chars. Redacted. No `tool_call` or `tool_output` item is written for it. |
| `steer` | `{text}` | The user steered a running turn. The text is redacted, and the open segment is closed first. |
| `compaction` | `{summary, turns_folded, folded: [turn_id]}` | The branch history neared 80 % of the context window (estimated at about 4 chars per token). It is recorded on the oldest kept turn: the last three turns stay unfolded. `summary` is at most 8 000 chars. When the model's history is built, only the latest compaction counts: it stands in for the turns it folded. |
| `notice` | `{event, …}` | A runtime note. The events are listed below. |
| `error` | `{message, action?}` | A turn failure the user can read. `action: "settings"` when no usable model is configured. |

#### Notice events

| `event` | Extra fields | Written by |
| --- | --- | --- |
| `started` | — | a turn starts running |
| `completed`, `failed`, `cancelled`, `interrupted` | `error?` | a turn finishes. The event name equals the final status. |
| `cancelled` | `queued: true` | a queued turn was withdrawn |
| `stopped` | — | Stop ended a streamed run between steps |
| `finalized` | `reason: "budget" \| "provider"` | the answer was written from the work so far by one tool-less call |
| `compacted` | `turns_folded` | older turns were folded into a `compaction` item |
| `titled` | `title` | the title step renamed the task after its first answer |
| `resumed` | `note, resumed_from` | the first item of a `resume` turn. `note` is replayed to the model as a user message. |
| `interrupted` | — | restart recovery found the turn still running |
| `imported` | `from: "v4"` | the first turn of a task imported from v4 |

### `artifacts`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | |
| `task_id` | TEXT → `tasks(id)` ON DELETE CASCADE | `NULL` for watch surveys |
| `turn_id` | TEXT → `turns(id)` ON DELETE SET NULL | |
| `kind` | TEXT NOT NULL | see below |
| `title` | TEXT NOT NULL | at most 200 chars |
| `provider_id` | TEXT | |
| `payload` | TEXT | JSON |
| `path` | TEXT | reserved; no current writer sets it |
| `created_at` | TEXT NOT NULL | |

Indexes: `idx_artifacts_task (task_id, created_at)` and
`idx_artifacts_kind (kind, provider_id, created_at)`.

The code writes these kinds:

| Kind | Writer | Title | Payload |
| --- | --- | --- | --- |
| `survey` | `survey_account` tool, only for a successful survey | `Account survey · <account>` | The full survey profile: `{success, provider_id, list_status, visible, processed, truncated, whole_account, summary, summary_text, buckets: [per-bucket snapshot + bucket_name, access_status, evidence_sources]}` |
| `survey` | watch sweep (`task_id` is `NULL`) | `Watch survey · <account>` | Same profile. Only the newest 3 task-less surveys per provider are kept. |
| `review` | `review_bucket_config` tool (inside a task) | `Configuration review · <bucket>`, naming the aspects when not all ran | `{bucket, aspects, findings}` (at most 200 findings) |

`compare_to_last_survey`, `query_estate` with `survey_filter` and evidence import read the
newest `survey` artifacts of a provider, including watch surveys.

## Datasets

### `datasets`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | |
| `task_id` | TEXT → `tasks(id)` ON DELETE CASCADE | |
| `origin` | TEXT NOT NULL | `upload` or `import` |
| `dataset_type` | TEXT NOT NULL | `access_log` or `inventory` |
| `filename` | TEXT NOT NULL | sanitized and redacted |
| `path` | TEXT NOT NULL | the raw file, relative to the data directory |
| `size_bytes` | INTEGER NOT NULL, default 0 | |
| `row_count` | INTEGER | set after ingest |
| `status` | TEXT NOT NULL | `ready` (saved) → `analyzed` (loaded into DuckDB). The schema comment also lists `failed`, but no code writes it. |
| `detail` | TEXT | JSON, redacted. For imports: `{files, bytes, partial, source_bucket, source_prefix, warnings}`. After ingest it also holds `format`, `truncated` and `ingest_cap` when the engine reports them. |
| `provider_id`, `bucket` | TEXT | set for imports |
| `created_at` | TEXT NOT NULL | |

Index: `idx_datasets_task (task_id, created_at)`.

### Layout on disk

```text
<data>/tasks/<task_id>/datasets/<dataset_id>/
    raw/<filename>        uploaded file (streamed via a .part-<rand> temp file, at most 2 GiB)
    raw/combined.log      imported access logs, combined
    raw/combined.csv      imported inventory (CSV, or any non-Parquet format), combined
    raw/combined.parquet  imported inventory (Parquet), combined
    data.duckdb           analytical database, created on first analysis
```

Directories are created owner-only. Upload file names are sanitized: the base
name only, unsafe characters replaced, at most 120 chars, and a
credential-shaped name replaced by `upload-<rand><ext>`. During an import,
the downloaded parts go to `raw/parts/` and are removed once the combined
file exists. A failed import removes the dataset directory.

Raw rows never leave this directory. The model sees only bounded metrics,
findings and whitelisted aggregates.

## Estate

The estate records what the work has established about the user's storage.
Issues are opened, resolved and marked recurred only by deterministic
observations: survey posture, the security and lifecycle aspects of a
`review_bucket_config` run, a Verify re-check, and a watch sweep.
Model prose never changes an issue. An observation that could not read
something decides nothing.

### `estate_buckets`

| Column | Type | Notes |
| --- | --- | --- |
| `provider_id` | TEXT NOT NULL → `cloud_providers(id)` ON DELETE CASCADE | primary key, together with `bucket` |
| `bucket` | TEXT NOT NULL | |
| `region` | TEXT | kept when a later observation has none |
| `posture` | TEXT | JSON posture projection: status enums (strings, at most 64 chars) and booleans only, for these keys: `head_bucket_status`, `access_status`, `versioning_status`, `versioning_enabled`, `encryption_status`, `lifecycle_status`, `logging_status`, `logging_enabled`, `replication_status`, `policy_status`, `public_access_block_status`, `policy_public_status`, `policy_is_public`, `object_ownership`, `acls_disabled`, `acl_public`, `publicly_exposed`, `tagging_status`, `inventory_status`. Never raw policy, ACL or configuration documents. |
| `last_checked_at` | TEXT NOT NULL | |
| `source_task_id` | TEXT | the last task that observed the bucket |

A survey whose profile has `whole_account: true` removes buckets that are no
longer listed and resolves their active issues (detail
`{reason: "bucket_no_longer_listed"}`). A survey is whole-account when it was
not truncated, stopped, scope-filtered or narrowed.

### `issues`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | |
| `provider_id` | TEXT NOT NULL → `cloud_providers(id)` ON DELETE CASCADE | |
| `bucket` | TEXT NOT NULL | |
| `code` | TEXT NOT NULL | rule code (below) |
| `fingerprint` | TEXT NOT NULL UNIQUE | `<provider_id>:<bucket>:<code>`. There is one issue per fingerprint. |
| `severity` | TEXT NOT NULL | from the rule |
| `status` | TEXT NOT NULL | `open`, `fix_proposed`, `resolved`, `recurred` or `accepted` |
| `detail` | TEXT | redacted, at most 800 chars |
| `first_seen_at`, `last_seen_at` | TEXT NOT NULL | |
| `resolved_at`, `resolved_by` | TEXT | `resolved_by` is the source: `survey`, `review`, `verify` or `watch` |
| `source_task_id` | TEXT | the task that found the issue (for a watch, the task it opened) |
| `fix` | TEXT | JSON `{kind: "public_access_block" \| "default_encryption" \| "lifecycle", document, command, notes: [], formats: [{format: "cli" \| "terraform" \| "json", label, text}]}` |
| `last_verified_at` | TEXT | |
| `last_verify_result` | TEXT | `still_present`, `resolved` or `inconclusive` |
| `updated_at` | TEXT NOT NULL | |

Indexes: `idx_issues_status (status, severity)`, `idx_issues_bucket (provider_id, bucket)`.

**Rules** (`estate/rules.py`):

| Code | Severity | Check | Deterministic fix |
| --- | --- | --- | --- |
| `public_exposure` | high | security | public access block |
| `wildcard_principal` | medium | security | none (depends on intent) |
| `cors_all_origins` | medium | security | none (depends on intent) |
| `no_default_encryption` | medium | security | default encryption (SSE-S3) |
| `public_access_block_missing` | medium | security | public access block |
| `no_abort_mpu` | medium | lifecycle | lifecycle rule (abort incomplete multipart uploads after 7 days) |
| `noncurrent_never_expire` | medium | lifecycle | lifecycle rule (expire noncurrent versions after 30 days) |

**Lifecycle.** For each decided verdict, one observation does the following:

| Verdict | No issue yet | Issue is `resolved` | Issue is active |
| --- | --- | --- | --- |
| present | insert as `open` (event `opened`) | → `recurred` | update `last_seen_at` and `detail` |
| absent | nothing | nothing | → `resolved` |
| undecided | nothing | nothing | nothing |

User actions add these transitions:

- Fix: `open` or `recurred` → `fix_proposed`.
- Accept: `open`, `fix_proposed` or `recurred` → `accepted`.
- Un-accept: `accepted` → `open`, with detail `{reopened: true}`.

"Active" means `open`, `fix_proposed`, `recurred` or `accepted`. "Care" means
the same set without `accepted`.

### `issue_events`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | |
| `issue_id` | TEXT NOT NULL → `issues(id)` ON DELETE CASCADE | |
| `kind` | TEXT NOT NULL | `opened`, `resolved`, `recurred`, `fix_proposed`, `accepted`, `open` (re-opened), `verified` |
| `source` | TEXT | `survey`, `review`, `verify`, `watch` or `user` |
| `detail` | TEXT | JSON, for example `{kind}` on a fix, `{result}` on a verify, `{reopened: true}`, `{reason}` |
| `created_at` | TEXT NOT NULL | |

Index: `idx_issue_events_issue (issue_id, id)`. The table is append-only.

### `posture_history`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | |
| `provider_id` | TEXT NOT NULL → `cloud_providers(id)` ON DELETE CASCADE | |
| `bucket` | TEXT NOT NULL | |
| `posture` | TEXT NOT NULL | the same JSON posture projection as `estate_buckets.posture` |
| `source` | TEXT NOT NULL | `survey` or `watch` |
| `task_id` | TEXT | the task whose survey observed it |
| `observed_at` | TEXT NOT NULL | |

A row is appended only when the projection differs from the bucket's latest
row; the last 50 per bucket are kept. A bucket forgotten by a whole-account
survey loses its history too. Index: `idx_posture_history_bucket (provider_id, bucket, id)`.

### `notes`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | |
| `provider_id` | TEXT → `cloud_providers(id)` ON DELETE CASCADE | `NULL` for an estate-wide note |
| `bucket` | TEXT | set only with `provider_id` |
| `text` | TEXT NOT NULL | redacted, eager secret masking, ≤ 1 000 chars |
| `source` | TEXT NOT NULL | `user`, `agent` (the `note` tool) or `accept` (the reason a risk was accepted) |
| `task_id` | TEXT | the task that wrote it (agent notes) |
| `issue_id` | TEXT | the accepted issue (accept notes) |
| `created_at`, `updated_at` | TEXT NOT NULL | |

At most 500 notes are kept. Index: `idx_notes_scope (provider_id, bucket, updated_at)`.

### `watch_schedules`

| Column | Type | Notes |
| --- | --- | --- |
| `provider_id` | TEXT PK → `cloud_providers(id)` ON DELETE CASCADE | |
| `enabled` | INTEGER NOT NULL, default 0 | off by default |
| `interval_hours` | INTEGER NOT NULL, default 24 | clamped to 1–168 by the API |
| `next_run_at` | TEXT | `NULL` while disabled |
| `last_run_at`, `last_status`, `last_summary`, `last_task_id` | TEXT | `last_status` is `running`, `found`, `clear` or `failed`. `last_summary` is redacted, at most 600 chars. |
| `updated_at` | TEXT NOT NULL | |

## Providers

### `model_providers`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | |
| `name`, `kind`, `model` | TEXT NOT NULL | `kind` is `openai`, `anthropic`, `deepseek`, `openrouter`, `ollama`, `lmstudio`, `vllm`, `llamacpp` or `openai-compatible` |
| `base_url` | TEXT | `NULL` means the kind's default |
| `api_key_ref` | TEXT | `keyring://model_provider/<id>/api_key` |
| `api_style` | TEXT NOT NULL, default `'chat'` | `responses` or `chat` |
| `context_window`, `max_output_tokens` | INTEGER | `NULL` means derived from the model |
| `reasoning_effort` | TEXT | `low`, `medium`, `high` or `NULL` |
| `active` | INTEGER NOT NULL, default 0 | Exactly one row is active whenever any exist; the oldest row becomes active by default. |
| `created_at`, `updated_at` | TEXT NOT NULL | |

### `cloud_providers`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | |
| `name`, `provider_type` | TEXT NOT NULL | |
| `endpoint_url`, `region`, `addressing_style`, `signature_version` | TEXT | |
| `access_key_ref`, `secret_key_ref`, `session_token_ref` | TEXT | `keyring://cloud_provider/<id>/<field>` |
| `allowed_buckets_json`, `allowed_prefixes_json` | TEXT NOT NULL, default `'[]'` | The scope, enforced server-side by every tool. An empty list means unrestricted. |
| `created_at`, `updated_at` | TEXT NOT NULL | |

## Settings

`settings (key TEXT PK, value TEXT NOT NULL, updated_at TEXT NOT NULL)`.
These keys are used:

| Key | Value | Written by |
| --- | --- | --- |
| `language` | `en` or `zh` (default `en`). Also sets the Agent's prompt language and the language of issue titles in `query_estate`. | `PATCH /settings` |
| `theme` | `system`, `light` or `dark` (default `system`) | `PATCH /settings` |
| `imported_from_v4` | JSON counts from the importer (`{}` when nothing was imported). Its presence means the import has run. | importer |

## Audit

`audit` is append-only and sanitized.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | |
| `at` | TEXT NOT NULL | |
| `actor` | TEXT NOT NULL | `agent`, `user`, `watch` or `mcp`. The schema comment also lists `system`, but no code writes it. |
| `action` | TEXT NOT NULL | at most 120 chars |
| `task_id` | TEXT | |
| `target` | TEXT | bucket or provider, at most 300 chars |
| `ok` | INTEGER NOT NULL, default 1 | |
| `duration_ms` | INTEGER | |
| `detail` | TEXT | redacted JSON |

Indexes: `idx_audit_at (at)` and `idx_audit_task (task_id, id)`.

| Action | Actor | Detail |
| --- | --- | --- |
| `tool.<name>` | `agent` | `{args, summary}`, or `{refused}` with `ok = 0` for a scope refusal |
| `tool.<name>` | `mcp`, or `user` for `tool.test_credentials` from Settings | `{args}`, or `{refused}` |
| `tool.review_bucket_security`, `tool.review_bucket_lifecycle` | `user` (Verify) or `watch` (sweep re-check) | `{source}` |
| `evidence.import` | `agent` | `{source_type, files, bytes, approved_by: "agent", bounds: {files, bytes}}` |
| `file.upload` | `user` | `{type, bytes}` |
| `task.rename`, `task.delete` | `user` | — |
| `model_provider.create`, `.update`, `.delete` | `user` | — |
| `cloud_provider.create`, `.update`, `.delete` | `user` | — |
| `watch.set` | `user` | `{enabled, interval_hours}` |

## Spans

A local trace processor (`agent/tracing.py`) replaces the Agents SDK's
uploading exporter. It stores each finished SDK span with names, kinds,
timings and sizes only, never prompts, arguments or outputs.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | SDK span ID |
| `trace_id` | TEXT NOT NULL | |
| `parent_id` | TEXT | |
| `task_id`, `turn_id` | TEXT | from the run's trace metadata |
| `kind` | TEXT NOT NULL | SDK span type: `agent`, `function`, `generation`, `response`, `guardrail`, `custom`, `mcp_tools`, … |
| `name` | TEXT NOT NULL | the span's `name` or `model`, else its kind; at most 120 chars |
| `started_at`, `ended_at` | TEXT | |
| `error` | TEXT | message only, at most 300 chars |
| `attributes` | TEXT | JSON, whitelisted per kind: `agent`/`function`/`custom` → `name`; `generation` → `model`; `guardrail` → `name`, `triggered`; `mcp_tools` → `server`. Plus `usage` integer counts when the span reports them. |

Indexes: `idx_spans_trace (trace_id)` and `idx_spans_turn (turn_id)`.
`GET /tasks/{id}/trace` exports a task's spans as OTLP-shaped JSON.

## Import from v4

A v4 `app.db` is read once, at the first start, by `sidecar/app/importer.py`,
and is never modified.

The importer runs only when all of the following are true:

- the `imported_from_v4` setting is absent;
- `<data>/app.db` exists and is not the v5 database file;
- the new database has no tasks, model providers or cloud providers.

It opens `app.db` read-only (`mode=ro`). If the database already holds data,
it records `imported_from_v4 = {}` without importing. On a
`sqlite3.DatabaseError`, it rolls back, logs the exception type, and still
records the setting. Startup never fails because of the import.

What it copies:

| From v4 | To v5 |
| --- | --- |
| `model_providers` | `model_providers`. `provider_type` is normalized to a v5 `kind` (aliases such as `llama.cpp` → `llamacpp` and `custom` → `openai-compatible`; unknown values → `openai-compatible`). `api_style` is derived from the kind and base URL. The first row (oldest) is made active. The `keyring://` references carry over; the secrets stay in the vault. |
| `cloud_providers` | `cloud_providers`, column for column, with the vault references |
| `sessions`: the 500 most recently updated | `tasks` (`origin = 'user'`). `title_source` is kept when it is `seed`, `agent` or `user`. |
| `session_messages`: at most 400 per session, in order | Each user message becomes a `completed` `direction` turn chained after the previous one, with a `user_message` item (text cut to 16 000 chars for the turn's `direction`). The first turn also gets `notice {event: "imported", from: "v4"}`. Each assistant message becomes a `conclusion` item (when v4 has a `conclusion` column holding JSON with an `answer`; `call_id = "imported-<message id>"`) followed by an `agent_message` item. The task's head is its last turn. Tool calls and runs are not imported. |
| `estate_buckets` | `estate_buckets` (`posture_json_sanitized` → `posture`) |
| `issues` | `issues` (`detail_sanitized` → `detail`, `fix_json_sanitized` → `fix`) |
| `issue_events` | `issue_events` (`detail_json_sanitized` → `detail`), only for issues that exist |
| `watch_schedules` | `watch_schedules` (`last_summary_sanitized` → `last_summary`), only for providers that exist |

`source_task_id` and `last_task_id` are kept only when they point to an
imported task; otherwise they are set to `NULL`. The setting's value is
`{model_providers, cloud_providers, tasks, buckets, issues}` counts.
