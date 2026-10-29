# Data model

## Application tables (`storage-agent.db`)

`user_version` is the schema version (head **16**). Migrations are append-only
in `main/db.ts`; the schema is created with `CREATE TABLE IF NOT EXISTS`, then
old databases are brought forward by version checks. There is no separate
migration tool.

| Table | Columns (essential) |
|---|---|
| `providers` | `id`, `name`, `kind` (`aws`/`r2`/`minio`/`aliyun`/`gcs`/`other`), `endpoint`, `region`, `force_path_style`, `auth` (`keys`/`profile`), `profile`, `access_key_id`, `secret_ref`, `session_ref`, `scope_json`, `created_at` |
| `notes` | `id`, `scope` (`estate`/`provider`/`bucket`), `ref`, `text`, `author` (`agent`/`user`), `created_at` |
| `audit` | `id`, `conversation_id`, `tool`, `target`, `outcome`, `at` |
| `task_meta` | `conversation_id`, `title`, `created_at`, `updated_at`, `pinned`, `model_json` |
| `datasets` | `id`, `conversation_id`, `kind`, `path`, `rows`, `bytes`, `created_at` |
| `search_docs` | `conversation_id`, `entry_id`, `kind`, `text`, `at` — derived index |
| `search_docs_fts` | FTS5 trigram mirror of `search_docs`; short queries fall back to LIKE |

`secret_ref` and `session_ref` are vault references (ciphertext), never
plaintext. A profile account stores an empty `secret_ref`, an empty
`session_ref` and only the profile name. `scope_json` holds `{ "buckets": [] }`;
an empty list means every bucket the credentials can see.

The app keeps no copy of the storage. There is no bucket table, no remembered
posture, no Issue and no reading record: what the storage holds is read again,
by the agent, when a turn needs it. The `@` menu lists the buckets an account
lists now (cached for a minute in memory).

`notes` is the agent's memory. `note` writes a row with `author = 'agent'`;
`ref` is the provider id for a provider note and `<provider>/<bucket>` for a
bucket note. The digest shows the first 12 notes of N at the start of every
turn. The user forgets a note in Settings.

`task_meta.model_json` is a per-task model override (`provider`, `modelId`,
`baseUrl`, `thinking`); null means the model in Settings. The provider key is
never stored here.

`search_docs` is rebuilt per conversation when a turn settles and backfilled
at startup; its FTS5 trigram mirror is rebuilt with it. It stores one row per
user message, steers included (`kind = 'user'`), and one per agent text
(`kind = 'answer'`), each keyed by its entry id, so a hit opens the task and
scrolls to that message. Title search reads `task_meta` directly.

`audit` records executed tool calls: tool, redacted target (none for `note`),
outcome (`ok`, `refused`, `stopped`, `error`) and conversation.

## pi tables

pi-durable creates its own tables in the same database under the prefix `pi_`
(`SqliteStorage.open(database, { prefix: 'pi_' })`). Do not query them directly
from product code; use `conversation.viewState()` and `watch()`. The host schema
purges the task-scoped pi rows on delete.

Entry kinds the window understands:

| Kind | Meaning |
|---|---|
| `sa.run` | a user message; data `{ trigger: 'user', text, attachments, context? }`. It starts a turn |
| `sa.steer` | a message sent while the agent works; data `{ text, attachments, context? }`. It joins the running turn |
| `sa.resume` | the user continued a stopped turn; the model gets `Continue.` and nothing else; shown as a divider |
| `sa.notice` | an app notice; data `{ code, text, tone, action? }`, worded by the window. Codes written: `stopped`, `no_answer`, `failed`, `budget` |
| `pi.assistant` | model output; its text and reasoning are projected, `model` is not sent to the window. A message that stopped at the output limit adds a `cut` notice |
| `pi.tool-result` | a tool result; `details` is `{ target, note, progress, args, view, ms, status, evidenceId }`; its text content is exactly what the model received, and the step shows it |
| `pi.compaction` | compaction divider |

`details.view` is one of the `ToolView` kinds in `shared/contract.ts`:
`buckets`, `objects`, `object`, `raw` (a `config` or `account` read as the API
returned it), `probe`, `note`, `query` and `question`. The window renders a view
only for a tool this build registers and a kind it knows (`project.ts`
`viewOf`). A call to a tool of an earlier version (`survey`, `estate`,
`change_plan`, `accept_risk`, …) still shows as a step with its status, note and
exactly what the agent received, without a view.

Entries 35.x wrote still open: an `sa.call` reads as a tool step and an
`sa.answer` as agent text; the `sa.run` that started a 35.x scripted check
(`trigger: 'check'` or `'recheck'`) and an `sa.reverify` comparison are not
shown. A `pi.user` entry (35.x's answer correction) is not shown either. 36
writes none of these.

A call the runaway ceiling blocked has no `details`: it shows as a step that
did not run, with the block text as what the agent received. An `ask` result
carries a `question` view; the turn ends until the user answers.

The turn's round count is never stored separately: `runtime/agent.ts` derives
it from these entries, so a restarted process has the same ceiling.

pi's `pi.usage` document supplies the task's token and cost totals; the
overflow menu's JSON export includes them.

## Migration 16

36.0 removes everything the app judged on its own. It drops `issue_events`,
`issues`, `readings`, `posture_changes` and `buckets`, and the provider columns
`account_json`, `account_at` and `schedule` (used only by the removed rule
engine and scheduled checks). Accounts, notes and tasks stay.

## Migration 15

Tasks written before 35.0 use entry kinds 35 does not read, so migration 15
starts the task history over: it drops the `pi_*` tables and clears
`task_meta`, `search_docs`, `datasets` and `audit`, and the shell clears
`tasks/` on disk. Accounts and notes stay.

## Datasets

One SQLite file per import at `tasks/<conversation>/datasets/<id>.sqlite`.
`access_logs` and `inventory_objects` hold redacted, normalized rows, with
client IPs masked at import. They are reached through `query`'s `dataset`,
`aggregate` and `rows` primitives; there is no separate analysis tool and no
arbitrary SQL. Imports are capped at 2,000,000 rows; a larger file is imported
up to the cap and reported as truncated. Inventory full imports are also bounded
by manifest file count, per-file bytes and total bytes. Dataset files are never
loaded into model context.

## Retention

Tasks, entries and notes persist until the user deletes them.

Deleting a task is a real purge in one transaction: `task_meta`, `search_docs`,
the task's `pi_conversations` / `pi_entries` / `pi_tasks` / `pi_submissions` /
`pi_documents` / `pi_document_revisions` rows, datasets, audit events, and
`tasks/<conversation>/` on disk (uploads included).

Removing an account deletes the provider row and its account- and
bucket-scoped notes. Audit rows of tasks that read it stay with their tasks.
There is no import from earlier versions of the app.

The sidebar reads the 500 most recently updated tasks and Settings shows the
100 most recent notes; older rows remain in the database. This is an
implementation limit, not a second archive.
