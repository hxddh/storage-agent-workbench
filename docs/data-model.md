# Data model

## Application tables (`storage-agent.db`)

`user_version` is the schema version (head **16**). Migrations are append-only
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
| `readings` | `id`, `conversation_id`, `provider_id`, `at`, `trigger` (`task`; older rows may hold `check`/`reverify`), `visible`, `processed`, `pending`, `denied`, `unknown`, `truncated`, `open_high`, `open_total` |
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

`readings` is the compact history of settled account reads: one row per account
a settled turn surveyed account-wide (a survey narrowed to named buckets adds no
row of its own; `runtime/readings.ts`). It stores the survey's counts and the
open Issue totals at the time — no verdict, never a request, answer, policy
document, account id or secret. Every row 36 writes has `trigger = 'task'`;
`estate` history shows older `check` and `reverify` rows as `checked` and
`rechecked`. Only the agent reads them: a change plan's baseline is the
account's latest row, and `estate` history includes up to 30 reading rows in an
unfiltered view. The window does not show readings.

`task_meta.model_json` is a per-task model override (`provider`, `modelId`,
`baseUrl`, `thinking`); null means the model in Settings. The provider key is
never stored here.

`search_docs` is rebuilt per conversation when a turn settles and backfilled
at startup; its FTS5 trigram mirror is rebuilt with it. It stores one row per
user message, steers included (`kind = 'user'`), and one per agent text
(`kind = 'answer'`), each keyed by its entry id, so a hit opens the task and
scrolls to that message. Title search reads `task_meta` directly.

`audit` records executed tool calls: tool, redacted target, outcome and
conversation.

## pi tables

pi-durable creates its own tables in the same database under the prefix `pi_`
(`SqliteStorage.open(database, { prefix: 'pi_' })`). Do not query them directly
from product code; use `conversation.viewState()` and `watch()`. The host schema
purges the task-scoped pi rows on delete.

Entry kinds the window understands:

| Kind | Meaning |
|---|---|
| `sa.run` | a user message; data `{ trigger: 'user', text, attachments, context? }`. It starts a turn |
| `sa.steer` | a message sent while the agent works; data like `sa.run`. It joins the running turn |
| `sa.resume` | the user continued a stopped turn; the model gets `Continue.` and nothing else; shown as a divider |
| `sa.notice` | an app notice; data `{ code, text, tone, action? }`, worded by the window. Codes: `stopped`, `no_answer`, `failed`, `budget` |
| `pi.assistant` | model output; its text and reasoning summary are projected, `model` is not sent to the window |
| `pi.tool-result` | a tool result; `details` is `{ target, note, progress, args, view, ms, status, evidenceId }`; its text content is exactly what the model received, and the step shows it |
| `pi.compaction` | compaction divider |

Entries 35.x wrote still open: an `sa.call` reads as a tool step and an
`sa.answer` as agent text; the `sa.run` that started a 35.x scripted check
(`trigger: 'check'` or `'recheck'`) and an `sa.reverify` comparison are not
shown. A `pi.user` entry (35.x's answer correction) is not shown either. 36
writes none of these.

35.x results may still carry `details.key` and `details.assessed`; 36 neither
writes nor reads them. A call the runaway ceiling blocked has no `details`: it
shows as a step that did not run, with the block text as what the agent
received. An `accept_risk` result carries an `accept` view (`{ issue, accept }`);
it records a request, not an acceptance.

The turn's round count is never stored separately: `runtime/agent.ts` derives
it from these entries, so a restarted process has the same budget.

pi's `pi.usage` document supplies the task's token and cost totals; the
overflow menu's JSON export includes them.

## Migration 16

36.0 drops `readings.complete` and recreates `readings_provider_at` on
`(provider_id, at)`. The column was a verdict the app composed from a survey's
counts; the counts stay, and so do accounts, memory, Issues and tasks.

## Migration 15

Tasks written before 35.0 use entry
kinds 35 does not read,
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
