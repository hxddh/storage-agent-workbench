# Data model

## Host tables (`storage-agent.db`)

`main/db.ts` holds one schema, `HOST_SCHEMA_VERSION` **19**, stored in
`PRAGMA user_version`. A new database is created at that version. A database at
any other version is cleared and created again: every table goes, pi's
included, and the shell deletes `tasks/` and `memory.sqlite` on disk. Nothing
is migrated, imported or backed up.

| Table | Columns |
|---|---|
| `providers` | `id`, `name`, `endpoint`, `region`, `force_path_style`, `access_key_id`, `secret_ref`, `session_ref`, `scope_json`, `created_at`, `auth` (`keys`/`profile`), `profile` |
| `audit` | `id`, `conversation_id`, `tool`, `target`, `outcome`, `at` |
| `task_meta` | `conversation_id`, `title`, `created_at`, `updated_at`, `pinned`, `model_json` |
| `datasets` | `id`, `conversation_id`, `kind`, `path`, `rows`, `bytes`, `created_at` |
| `agent_tools` | `id`, `scope`, `conversation_id`, `name`, `description`, `schema_json`, `code`, `created_at`, `updated_at` |
| `search_docs` | `conversation_id`, `entry_id`, `kind`, `text`, `at`: a derived index |
| `search_docs_fts` | FTS5 trigram mirror of `search_docs` |

**`providers`** are the storage accounts. An empty `endpoint` means AWS.
`secret_ref` and `session_ref` are vault references (ciphertext), never
plaintext. A profile account stores only the profile name, with an empty
`secret_ref`. `scope_json` is `{ "buckets": [] }`; an empty list means every
bucket the credentials can see.

**`agent_tools`** holds methods the agent wrote for itself. `scope` is `task`
or `user`; a task method has a `conversation_id`, a user method has null.
`schema_json` is a JSON Schema, `code` is the JavaScript body. Task methods are
deleted with their task; user methods survive until the agent or the user
deletes them. The Settings Methods pane lists both and can delete either.

**`task_meta.model_json`** is a per-task model choice (`provider`, `modelId`,
`baseUrl`, `thinking`); null means the model in Settings. No key is stored
there.

**`search_docs`** holds one row per user message, steers included
(`kind = 'user'`), and one per agent text (`kind = 'answer'`), keyed by entry
id, so a hit opens the task at that message. It is rebuilt for a conversation
when a turn settles, and filled at startup for tasks that have no rows. Title
search reads `task_meta`. Queries of three or more characters use FTS5 BM25
ranking with user text ahead of answers; shorter queries, including CJK
substrings, use `LIKE`.

**`audit`** records each call that went through `agentTool()`: tool, redacted
target, outcome (`ok`, `refused`, `stopped`, `error`) and conversation. A tool
whose view is a `note` (for example `more`, a memory put or a method save)
writes a null target. For `call` the target is `<service> <operation>`, with
` · <bucket>` when the input names one. `ask` is not audited.

The app keeps no copy of the storage. What a bucket holds is read again, by
the agent, when a turn needs it. The `@` menu lists the buckets an account
lists now, cached in memory for a minute.

## Memory (`memory.sqlite`)

A separate SQLite file, so a memory query can never reach host tables that
hold accounts, task metadata or sealed secret references. `MemoryStore` owns
it.

| Column | Meaning |
|---|---|
| `id` | UUID |
| `scope` | `task` or `user` |
| `conversation_id` | the task for task scope; null for user scope |
| `key` | the document key, unique within scope and conversation |
| `value_json` | arbitrary JSON |
| `text` | searchable text, defaulting to the JSON rendering of the value |
| `tags_json` | string tags |
| `created_at`, `updated_at` | ISO timestamps |

The agent reads and writes it through `memory` or `query`'s `memory()`
primitive. `query` SQL runs on a read-only connection and must be one
`SELECT`. The window lists every document with its key and scope and can
forget one. The prompt says only how many documents exist; content is not
injected.

## pi tables

pi-durable creates its tables in the same database under the prefix `pi_`.
Product code reads them only through `conversation.viewState()` and `watch()`.

Entry kinds the window shows:

| Kind | Meaning |
|---|---|
| `sa.run` | a user message, `{ text, attachments, context? }`; it starts a turn |
| `sa.steer` | a message sent while the agent works, `{ text, attachments, context? }`; it joins the running turn |
| `sa.resume` | the user continued a stopped turn; the model gets `Continue.`; shown as a divider |
| `sa.notice` | an app notice, `{ code, text, tone, action? }`, worded by the window. Codes: `stopped`, `no_answer`, `failed`, `cut` |
| `pi.assistant` | model output: text and reasoning are projected. A message that stopped at the output limit adds a `cut` notice; one that failed with no text shows the provider's error with **Retry** |
| `pi.tool-result` | a tool result; `details` is `{ target, note, progress, args, view, ms, status, evidenceId }`, and the text is exactly what the model received |
| `pi.compaction` | a compaction divider |

`details.status` is one of `running`, `done`, `failed`, `refused`, `stopped`.
`details.view` is one of the `ToolView` kinds in `shared/contract.ts`: `raw`
(a `call` response or a `probe` answer, as JSON), `note` (`more`, a memory put,
a method save or delete), `query`, `question`, `render`, `delegate` and
`memory` (rows from a memory list or query).

A result longer than one piece (24,000 characters) is not stored whole in the
entry: the entry holds the first piece, exactly what the model received, and
the whole text is a file at `tasks/<conversation>/results/<evidence>.txt` that
`more` reads. A streamed object body is a file at
`tasks/<conversation>/objects/<id>.bin`; the entry holds a 64 KiB preview and
the ref.

pi's `pi.usage` document supplies the task's token and cost totals; the JSON
export includes them.

## Datasets

One SQLite file per import at `tasks/<conversation>/datasets/<id>.sqlite`,
with a row in `datasets`. Two kinds exist: `access_log` (table `access_logs`)
and `inventory` (table `inventory_objects`), both normalized and redacted, with
client IPs masked at import. `query`'s `dataset()` imports an attached file
(log lines in common log format, JSON lines, CSV, TSV or Parquet; gzip is read
as it streams) and `inventory()` imports every file of a bucket's latest S3
Inventory manifest. `sql()` reads them: one `SELECT` over a `rows` view of the
dataset's table, on a read-only connection. Imports have no row cap. Dataset
files never enter model context; only rows a script returns do.

## Retention

Tasks, entries, user memory documents and user methods persist until the user
deletes them.

Deleting a task removes its `task_meta` and `search_docs` rows, its pi rows
(`pi_conversations`, `pi_entries`, `pi_tasks`, `pi_submissions`,
`pi_documents`, `pi_document_revisions`), datasets, audit rows, task-scoped
memory documents and task-scoped methods, and `tasks/<conversation>/` on disk,
uploads, kept results and streamed object bodies included. A delegated child
conversation is owned by one of the task's pi tasks; its rows, documents,
task-scoped memory, methods and folder are removed in the same purge.

Removing an account deletes its `providers` row and its cached clients. Memory
does not belong to an account and stays when an account is removed.

The sidebar reads the 500 most recently updated tasks, pinned first; older
rows stay in the database.
