# Data model

## Host tables (`storage-agent.db`)

`main/db.ts` holds the schema, stored in `PRAGMA user_version`. It moves
forward and is never cleared for an upgrade. `BASELINE_SCHEMA_VERSION` **22**
is 42.0.0's layout; `HOST_SCHEMA_VERSION` **23** is the current one.
`MIGRATIONS[n]` takes a database from version n − 1 to n, each step in its own
transaction.

- A new database is created at the baseline and takes every migration after
  it.
- A database at the baseline or later is migrated step by step and keeps what
  it holds.
- A database from a newer version is refused with a message (`This data was
  written by a newer Storage Agent…`) and nothing is changed.
- Only a layout older than the baseline, from before migrations existed, is
  cleared and created again: every table goes, pi's included, and the shell
  deletes `tasks/` and `datasets/` on disk. The workspace is never cleared.

| Table | Columns |
|---|---|
| `providers` | `id`, `name`, `endpoint`, `region`, `force_path_style`, `access_key_id`, `secret_ref`, `session_ref`, `scope_json`, `created_at`, `auth` (`keys`/`profile`), `profile`, `allow_changes`, `write_profile` |
| `audit` | `id`, `conversation_id`, `tool`, `target`, `outcome`, `at` |
| `task_meta` | `conversation_id`, `title`, `created_at`, `updated_at`, `pinned`, `model_json` |
| `datasets` | `id`, `scope` (`task`/`user`), `owner`, `name`, `format`, `source`, `path`, `rows`, `bytes`, `created_at` |
| `agent_tools` | `id`, `scope`, `conversation_id`, `name`, `description`, `schema_json`, `code`, `created_at`, `updated_at`: 42.0.0's methods, emptied by the import |
| `search_docs` | `conversation_id`, `entry_id`, `kind`, `text`, `at`: a derived index |
| `search_docs_fts` | FTS5 trigram mirror of `search_docs` |
| `schedules` | `id`, `name` (unique), `prompt`, `cadence`, `budget_tokens`, `conversation_id`, `task_id`, `created_by`, `next_at`, `last_at`, `last_outcome`, `enabled`, `created_at` |
| `changes` | `id`, `conversation_id`, `provider_id`, `kind`, `service`, `operation`, `input_json`, `reason`, `snapshot_json`, `status`, `result_json`, `rollback_of`, `created_at`, `decided_at` |
| `inbox` | `id`, `conversation_id`, `title`, `body`, `created_at`, `read_at` |

**`providers`** are the storage accounts. An empty `endpoint` means AWS.
`secret_ref` and `session_ref` are vault references (ciphertext), never
plaintext. A profile account stores only the profile name, with an empty
`secret_ref`. `scope_json` is `{ "buckets": [] }`; an empty list means every
bucket the credentials can see. `allow_changes` is 1 when the user allows
approved changes on the account (default 0). `write_profile` is an AWS
profile used only for approved changes; null uses the account's own
credentials.

**`datasets`** are local SQLite copies the agent imported. `scope` is `task`
or `user`; a task dataset's `owner` is its conversation, a user dataset's is
`user`. A name is unique per owner, so a kept dataset and a task dataset may
share a name; `sql()` resolves the task's first. A user dataset outlives tasks.

**`task_meta.model_json`** is a per-task model choice (`provider`, `modelId`,
`baseUrl`, `thinking`); null means the model in Settings. No key is stored
there.

**`schedules`** holds the agent's schedules. `cadence` is normalised: `at
<ISO>`, `every <n>m`, `daily HH:MM` or `weekly <day> HH:MM`, local time.
`budget_tokens` null means the default, 100,000. `conversation_id` is the
schedule's task; `task_id` is the pi task (`sa.schedule`) that times it;
`created_by` is the task that created it. `last_outcome` is `started` or why a
run could not start. A one-off schedule's row is deleted after its run;
`schedule cancel` deletes the row and aborts its pi task.

**`changes`** holds every proposal. `kind` is `change` (a storage write),
`settings` (an account setting the agent proposed with `self`; `service` is
`settings` and `operation` `UpdateAccount`) or `rollback` (the inverse of an
applied change, with `rollback_of` naming it). `input_json` is the exact call
input, redacted; `snapshot_json` is what the change replaces (`null` when
nothing was set; for a settings proposal, the account's setting before).
`status` is `proposed`, `applied`, `failed`, `rejected` or `rolled_back`;
`result_json` is the service's response or `{error}`; `decided_at` is when the
user decided. `conversation_id` is the task the proposal belongs to.

**`inbox`** holds what the agent told the user with `notify`: the task, the
title, the body, and `read_at` once the user opened it or marked it read.

**`search_docs`** holds one row per user message, steers included
(`kind = 'user'`), and one per agent text (`kind = 'answer'`), keyed by entry
id, so a hit opens the task at that message. A run's own entries are indexed
by the durable loop's `afterRun` hook, so an answer reaches search even when
the app quits before the turn settles; a failed or stopped run is indexed when
it settles. Tasks with no rows are filled at startup. Title search reads
`task_meta`. Queries of three or more characters use FTS5 BM25 ranking with
user text ahead of answers; shorter queries, including CJK substrings, use
`LIKE`.

**`audit`** records each call that went through `agentTool()`: tool, redacted
target, outcome (`ok`, `refused`, `stopped`, `error`) and conversation (an
`mcp-…` session id for a call served over MCP). A tool whose view is a `note`
(for example `more`, a workspace move or delete, `self title`) writes a null
target. For `call` the target is `<service> <operation>`, with ` · <bucket>`
when the input names one. `ask` and `delegate` are not audited.

The app keeps no copy of the storage. What a bucket holds is read again, by
the agent, when a turn needs it. The `@` menu lists the buckets an account
lists now, cached in memory for a minute.

## The workspace (`<data>/workspace/`)

The agent's folder, owned by `Workspace` (`workspace.ts`). It is not a table:
the agent organises plain files, by convention under `notes/`, `skills/`,
`data/`, `scripts/`, `board/` and `exports/`, and keeps its own SQL in
`db.sqlite`, whose schema is the agent's. A `board/<name>.view.json` holding
`{title, doc}` with a valid view document is on Home's board, newest first.
Kept datasets (`dataset({scope: 'user'})`) are written to `data/<id>.sqlite`.
The workspace belongs to no task and no account: deleting either leaves it,
and the app never clears it.

## 42.0.0's stores

`importLegacy` (`legacy.ts`) runs at every launch and moves what 42.0.0 kept
into the workspace once, losing nothing:

- every user-scoped memory document in `memory.sqlite` becomes
  `notes/memory/<key>.json` (key, value, text, tags, the task that wrote it,
  when), and the file is then renamed `memory.sqlite.imported`;
- every user skill in `<data>/skills/*.md` moves to the workspace's `skills/`;
- every user-scoped agent method becomes `scripts/<name>.js`, with its JSON
  Schema beside it as `scripts/<name>.schema.json`, and its `agent_tools` row
  is deleted.

A name already taken gets `-2`, `-3`, …. Task-scoped memory documents and
methods are not moved. Datasets 42.0.0 kept stay at `datasets/<id>.sqlite`,
where their rows point, and are read in place.

## pi tables

pi-durable creates its tables in the same database under the prefix `pi_`.
Product code reads them only through `conversation.viewState()` and `watch()`.
A schedule's timer is a background pi task (`sa.schedule`) owned by the
schedule's conversation; its state is `wait` or `fire` and the time it is due.

Entry kinds the window shows:

| Kind | Meaning |
|---|---|
| `sa.run` | a user message, `{ text, attachments, context? }`, or a scheduled run, `{ text, attachments, scheduled }`; it starts a turn |
| `sa.steer` | a message sent while the agent works, `{ text, attachments, context? }`; it joins the running turn |
| `sa.resume` | the user continued a stopped turn; the model gets `Continue.`; shown as a divider |
| `sa.notice` | an app notice, `{ code, text, tone, action? }`, worded by the window. Codes: `stopped`, `no_answer`, `failed`, `cut`, `budget` |
| `pi.assistant` | model output: text and reasoning are projected. A message that stopped at the output limit adds a `cut` notice; one that failed with no text shows the provider's error with **Retry** |
| `pi.tool-result` | a tool result; `details` is `{ target, note, progress, args, view, ms, status, evidenceId }`, and the text is exactly what the model received |
| `pi.compaction` | a compaction divider |

A decision on a change reaches the task as an ordinary `sa.run` message
(`Approved: …`, `Rejected: …`, `Rolled back: …`).

`details.status` is one of `running`, `done`, `failed`, `refused`, `stopped`.
`details.view` is one of the `ToolView` kinds in `shared/contract.ts`: `raw`
(a `call` response, a `probe` answer, a workspace listing, search or SQL
result, `self read`, a schedule, as JSON), `note` (`more`, a workspace move or
delete, `self title` or `pin`, `notify`), `query`, `question`, `render` (a
query's view, or a workspace file opened as Markdown or code), `delegate`,
`export` (a file written under `exports/`), `change` (a proposal, read again
from `changes` by its id) and `memory` (42.0.0 entries).

Every result is kept whole at `tasks/<conversation>/results/<evidence>.txt`,
which `more` and `read()` read at any offset; the entry holds exactly what the
model received, the first piece when the result is longer than one. A
delegated child writes into its task's folder, its evidence ids prefixed with
its own conversation id. Attachments are files at
`tasks/<conversation>/uploads/`, read as `attachment:<name>`. A streamed object
body is a file at `tasks/<conversation>/objects/<id>.bin`; the entry holds a
64 KiB preview and the ref.

pi's `pi.usage` document supplies the task's token and cost totals; the JSON
export includes them, and the unattended budget is measured from them.

## Datasets

A task dataset is one SQLite file at
`tasks/<conversation>/datasets/<id>.sqlite`; a kept dataset is at
`workspace/data/<id>.sqlite` under the data directory. Each has a row in
`datasets` (`scope`, `owner`, `name`, `format`, `source`, `path`, `rows`,
`bytes`); a name is unique per owner and a new import of it replaces the old
file. A task dataset is deleted with its task; a kept one stays until the agent
or the user forgets it. The file holds one table, `rows`, with the source's own
columns plus `_source` (the file or `s3://` URL a row came from):

| Format | Columns |
|---|---|
| `csv`, `tsv` | the header row, or the names given (an inventory manifest's `fileSchema`) |
| `jsonl`, `json` | every top-level key; nested values as JSON text; a line that is not JSON in `_line` |
| `parquet` | the file's schema |
| `s3_access_log` | every field AWS documents (`bucket_owner` … `acl_required`, extras as `field_N`), `time_iso`, and the `raw` line |
| `lines` | `line_no`, `line` |

Nothing is dropped, masked or cut. A numeric string that reads back the same
is stored as a number (a 12-digit one only in a column that holds quantities,
such as a size, so an account id stays text); every other string is kept
with credential-shaped text redacted. `query`'s `dataset()`
imports an attachment, an object body, one object or every object under a
prefix; `inventory()` imports every file of a bucket's latest S3 Inventory
manifest with the manifest's schema. `dataset({rows, name, scope: 'user'})`
keeps rows a script computed; it takes at most 500,000 rows, and one kept
dataset is limited to 512 MiB with 2 GiB across all kept datasets. `sql()`
reads a dataset by name, from any script of the task, task first and then the
user's: one `SELECT` on a read-only connection. Imports otherwise have no row
cap. Dataset files never enter model context; only what a script returns does.

## Retention

Tasks, entries, the workspace, schedules, kept datasets, changes and inbox
entries persist until the user or the agent removes them, and across app
versions: the schema migrates forward.

Deleting a task removes its `task_meta` and `search_docs` rows, its pi rows
(`pi_conversations`, `pi_entries`, `pi_tasks`, `pi_submissions`,
`pi_documents`, `pi_document_revisions`), datasets, audit rows and any
task-scoped `agent_tools` rows, and `tasks/<conversation>/` on disk, uploads,
kept results and streamed object bodies included. A delegated child
conversation is owned by one of the task's pi tasks; its rows, documents and
folder are removed in the same purge. The workspace, `changes` and `inbox`
rows are not the task's and stay. Deleting a schedule's task ends the schedule:
its `sa.schedule` timer goes with the task's pi rows and its `schedules` row
is deleted.

Removing an account deletes its `providers` row and its cached clients. The
workspace does not belong to an account and stays when an account is removed.

A kept dataset is removed by **Forget** in Settings or by the agent; nothing
prunes one by age. The sidebar reads the 500 most recently updated tasks,
pinned first; older rows stay in the database.
