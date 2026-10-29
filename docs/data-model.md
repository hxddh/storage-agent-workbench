# Data model

## Host tables (`storage-agent.db`)

`main/db.ts` holds one schema, `HOST_SCHEMA_VERSION` **17**, stored in
`PRAGMA user_version`. A new database is created at that version. A database
at any other version is cleared and created again: every table goes, pi's
included, and the shell empties `tasks/` on disk. There is no migration step.

| Table | Columns |
|---|---|
| `providers` | `id`, `name`, `endpoint`, `region`, `force_path_style`, `access_key_id`, `secret_ref`, `session_ref`, `scope_json`, `created_at`, `auth` (`keys`/`profile`), `profile` |
| `notes` | `id`, `text`, `created_at` |
| `audit` | `id`, `conversation_id`, `tool`, `target`, `outcome`, `at` |
| `task_meta` | `conversation_id`, `title`, `created_at`, `updated_at`, `pinned`, `model_json` |
| `datasets` | `id`, `conversation_id`, `kind`, `path`, `rows`, `bytes`, `created_at` |
| `search_docs` | `conversation_id`, `entry_id`, `kind`, `text`, `at`: a derived index |
| `search_docs_fts` | FTS5 trigram mirror of `search_docs` |

**`providers`** are the storage accounts. An empty `endpoint` means AWS.
`secret_ref` and `session_ref` are vault references (ciphertext), never
plaintext. A profile account stores only the profile name, with an empty
`secret_ref`. `scope_json` is `{ "buckets": [] }`; an empty list means every
bucket the credentials can see.

**`notes`** are the agent's memory: plain text and the time it was written.
The digest lists every note, newest first, with its id, except notes older
than the retention set in Settings. The agent forgets a note by its id; the
user forgets any note in Settings. Notes do not
belong to an account and stay when an account is removed.

**`task_meta.model_json`** is a per-task model choice (`provider`, `modelId`,
`baseUrl`, `thinking`); null means the model in Settings. No key is stored
there.

**`search_docs`** holds one row per user message, steers included
(`kind = 'user'`), and one per agent text (`kind = 'answer'`), keyed by entry
id, so a hit opens the task at that message. It is rebuilt for a conversation
when a turn settles, and filled at startup for tasks that have no rows. Title
search reads `task_meta`.

**`audit`** records each call that went through `agentTool()`: tool, redacted
target (none for `note` and `more`), outcome (`ok`, `refused`, `stopped`,
`error`) and conversation. For `call` the target is `<service> <operation>`,
with ` · <bucket>` when the input names one. `ask` is not audited.

The app keeps no copy of the storage. What a bucket holds is read again, by
the agent, when a turn needs it. The `@` menu lists the buckets an account
lists now, cached in memory for a minute.

## pi tables

pi-durable creates its tables in the same database under the prefix `pi_`.
Product code reads them only through `conversation.viewState()` and `watch()`.

Entry kinds the window shows:

| Kind | Meaning |
|---|---|
| `sa.run` | a user message, `{ text, attachments, context? }`; it starts a turn |
| `sa.steer` | a message sent while the agent works, `{ text, attachments, context? }`; it joins the running turn |
| `sa.resume` | the user continued a stopped turn; the model gets `Continue.`; shown as a divider |
| `sa.notice` | an app notice, `{ code, text, tone, action? }`, worded by the window. Codes: `stopped`, `no_answer`, `failed` |
| `pi.assistant` | model output: text and reasoning are projected. A message that stopped at the output limit adds a `cut` notice; one that failed with no text shows the provider's error with **Retry** |
| `pi.tool-result` | a tool result; `details` is `{ target, note, progress, args, view, ms, status, evidenceId }`, and the text is exactly what the model received |
| `pi.compaction` | a compaction divider |

`details.status` is one of `running`, `done`, `failed`, `refused`, `stopped`.
`details.view` is one of the `ToolView` kinds in `shared/contract.ts`: `raw`
(a `call` response or a `probe` answer, as JSON), `note` (`note` and `more`),
`query` and `question` (`ask`; the turn ends until the user answers).

A result longer than one piece (24,000 characters) is not stored whole in the
entry: the entry holds the first piece, exactly what the model received, and
the whole text is a file at `tasks/<conversation>/results/<evidence>.txt` that
`more` reads.

pi's `pi.usage` document supplies the task's token and cost totals; the JSON
export includes them.

## Datasets

One SQLite file per import at `tasks/<conversation>/datasets/<id>.sqlite`,
with a row in `datasets`. Two kinds exist: `access_log` (table `access_logs`)
and `inventory` (table `inventory_objects`), both normalized and redacted, with
client IPs masked at import. `query`'s `dataset()` imports an attached file
(log lines in common log format, JSON lines, CSV, TSV or Parquet;
gzip is read as it streams) and `inventory()` imports
every file of a bucket's latest S3 Inventory manifest. `sql()` reads them: one
`SELECT` over a `rows` view of the dataset's table, on a read-only connection.
Imports have no row cap. Dataset files never enter model context; only rows a
script returns do.

## Retention

Tasks, entries and notes persist until the user deletes them.

Deleting a task removes its `task_meta` and `search_docs` rows, its pi rows
(`pi_conversations`, `pi_entries`, `pi_tasks`, `pi_submissions`,
`pi_documents`, `pi_document_revisions`), datasets and audit rows, and
`tasks/<conversation>/` on disk, uploads and kept results included.

Removing an account deletes its `providers` row and its cached clients.

The sidebar reads the 500 most recently updated tasks, pinned first; older
rows stay in the database.
