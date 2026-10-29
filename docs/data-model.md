# Data model

## Application tables (`storage-agent.db`)

`user_version` is the schema version (head **14**). Migrations are append-only
in `main/db.ts`; the schema is created with `CREATE TABLE IF NOT EXISTS`, then
old databases are brought forward by version checks. There is no separate
migration tool.

| Table | Columns (essential) |
|---|---|
| `providers` | `id`, `name`, `kind` (`aws`/`r2`/`minio`/`aliyun`/`gcs`/`other`), `endpoint`, `region`, `force_path_style`, `auth` (`keys`/`profile`), `profile`, `access_key_id`, `secret_ref`, `session_ref`, `scope_json`, `account_json`, `account_at`, `schedule` (`off`/`daily`/`weekly`), `created_at` |
| `buckets` | `provider_id`, `name`, `posture_json`, `posture_at`, `region`, `first_seen`, `last_seen`, `gone_at` |
| `issues` | `id`, `provider_id`, `bucket`, `code`, `severity`, `status` (`open`/`resolved`/`accepted`), `detail`, `opened_at`, `resolved_at`, `accepted_at`, `last_seen_at`, `recurred` |
| `issue_events` | `id`, `issue_id`, `conversation_id`, `kind`, `at`, `detail_json` |
| `notes` | `id`, `scope` (`estate`/`provider`/`bucket`), `ref`, `text`, `author`, `created_at` |
| `audit` | `id`, `conversation_id`, `tool`, `target`, `outcome`, `at` |
| `task_meta` | `conversation_id`, `title`, `created_at`, `updated_at`, `pinned`, `model_json` |
| `posture_changes` | `id`, `provider_id`, `bucket`, `at`, `changes_json` |
| `readings` | `id`, `conversation_id`, `provider_id`, `at`, `trigger` (`check`/`task`/`reverify`), `complete`, `visible`, `processed`, `pending`, `denied`, `unknown`, `truncated`, `open_high`, `open_total` |
| `datasets` | `id`, `conversation_id`, `kind`, `path`, `rows`, `bytes`, `created_at` |
| `search_docs` | `conversation_id`, `entry_id`, `kind`, `text`, `at` — derived index |
| `search_docs_fts` | FTS5 trigram mirror of `search_docs`; short queries fall back to LIKE |

`secret_ref` and `session_ref` are vault references (ciphertext), never
plaintext. A profile account stores an empty `secret_ref`, an empty
`session_ref` and only the profile name. `scope_json` holds `{ "buckets": [] }`;
an empty list means every bucket the credentials can see.

`posture_json` stores status enums, booleans and capacity numbers
(`size_bytes`, `objects`, `monthly_usd`, `growth_bytes`, `capacity_at`). It never
stores a policy document, an account id or an ARN. `account_json` holds the
account block's status and switches only. The account rule's Issue uses the
empty string as its bucket.

`issues.detail` is a short phrase from the rule (for example
`Off: RestrictPublicBuckets`), never a document. `issue_events.kind` is
`opened`, `resolved`, `recurred`, `gone`, `accepted` or `reopened`. A bucket
with `gone_at` is left out of every listing and the digest; seeing it again
clears the mark. `recurred` counts reopenings of a resolved Issue.
`AppDb.listIssueEvents` joins `issue_events` to `issues` for `estate` history;
it is a read of these rows, not a second store.

`readings` is the compact history of settled account reads. It stores counts and
booleans, the triggering path and the current open Issue totals, never a request,
answer, policy document, account id or secret. `complete = 1` only for an
unscoped, closed survey; re-verification is always partial. Home selects each
account's latest complete row and the newest complete row overall; `estate`
history includes up to 30 reading rows in an unfiltered view.

`task_meta.model_json` is a per-task model override (`provider`, `modelId`,
`baseUrl`, `thinking`); null means the model in Settings. The provider key is
never stored here. A harness correction is a `pi.user` entry in the durable log;
the window projects it as a `validation` trace event, not a host table.

`search_docs` is rebuilt per conversation when a run settles and backfilled
at startup; its FTS5 trigram mirror is rebuilt with it. It stores every request,
every run's answer (`entry_id = 'answer:<answer entry>'`, so a hit on an earlier
run opens that run) and one row per risk seen by any run of the task
(`entry_id = 'f:<source entry>:<finding key>'`). The source entry id lets a
search hit load the evidence even when it is outside the window's initial page.
Title search reads `task_meta` directly.

`audit` records executed tool calls: tool, redacted target, outcome and
conversation, for model and scripted runs alike.

## pi tables

pi-durable creates its own tables in the same database under the prefix `pi_`
(`SqliteStorage.open(database, { prefix: 'pi_' })`). Do not query them directly
from product code; use `conversation.viewState()` and `watch()`. The host schema
purges the task-scoped pi rows on delete.

Entry kinds the window understands:

| Kind | Meaning |
|---|---|
| `sa.run` | starts a run; data `{ trigger: 'user', text, attachments, context? }` for a request (an input the model answers), `{ trigger: 'check' \| 'recheck', at }` for a scripted run (a write) |
| `sa.steer` | an input that joins a running run; data like a request |
| `sa.resume` | the user continued a stopped run; a row in the run, not a request |
| `sa.call` | one scripted call; data `{ name, at, details }`, details exactly as `agentTool()` returns them |
| `sa.answer` | a scripted run's answer; data `{ text, at }`; its `model` carries the run's enveloped results so a later model run in the task can read and cite them |
| `sa.reverify` | a re-check's comparison; data `ReverifyReport`, including plan-step status when the task has a change plan |
| `sa.notice` | an app notice; data `{ code, text, tone, action? }`, worded by the window |
| `pi.user` | the harness's one correction to the model; shown as a validation row |
| `pi.assistant` | model output; the text is projected, `model` is not sent to the window |
| `pi.tool-result` | a model's tool result; `details` is `{ target, note, progress, args, view, ms, status, evidenceId, key, assessed? }` |
| `pi.compaction` | compaction divider |

`details.key` is a hash of the call's exact arguments; the run ledger blocks a
repeated read by it. `details.assessed` is what the rules did with the reading
(Issues opened, resolved, recurred), written by `estate/assess.ts`.

The run's state (rounds, calls, names, evidence, coverage) is never stored
separately: `shared/ledger.ts` derives it from these entries, so a restarted
process rebuilds the same guards.

pi's `pi.usage` document supplies the task's token/cost receipt. A scripted
run has no model usage; its receipt still shows the calls and time.

## Migration 15

Schema head **15**. Tasks written before 35.0 use entry kinds 35 does not read,
so migration 15 starts the task history over: it drops the `pi_*` tables and
clears `task_meta`, `search_docs`, `datasets` and `audit`, and the shell clears
`tasks/` on disk. Accounts, remembered posture, Issues and their events, notes
and reading records stay; their links to old tasks become null.

## Datasets

One SQLite file per import at `tasks/<conversation>/datasets/<id>.sqlite`.
`access_logs` and `inventory_objects` hold redacted, normalized rows. They are
reached through `query`'s `dataset` and `aggregate` primitives; there is no
separate analysis tool and no arbitrary SQL. Imports are capped at 2,000,000
rows; a larger file is imported up to the cap and reported as truncated. Inventory
full imports are also bounded by manifest file count, per-file bytes and total
bytes, and return coverage. Dataset files are never loaded into model context.

## Retention

Tasks, entries, Issues and notes persist until the user deletes the task.
Removing an account deletes some account-scoped rows but is not a full purge.

Deleting a task is a real purge in one transaction: `task_meta`, `search_docs`,
the task's `pi_conversations` / `pi_entries` / `pi_tasks` / `pi_submissions` /
`pi_documents` / `pi_document_revisions` rows, datasets, audit events, and
`tasks/<conversation>/` on disk (uploads included). Issue events keep history
with `conversation_id` set to null; reading rows remain as account history with
the same null conversation id.

Removing an account deletes the provider row, its bucket rows, Issues,
posture-change rows, reading rows and account/bucket-scoped notes. `issue_events`
keep their historical rows with the Issue; there is no import from earlier
versions of the app.

The sidebar reads the 500 most recently updated tasks and Settings shows the
100 most recent notes; older rows remain in the database. This is an
implementation limit, not a second archive.
