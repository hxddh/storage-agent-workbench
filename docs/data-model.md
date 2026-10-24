# Data model

## Application tables (`storage-agent.db`)

`user_version` is the schema version (head **3**); migrations are append-only in
`main/db.ts`. Version 3 dropped the unused `watch` table and `task_meta.origin`.

| Table | Columns (essential) |
|---|---|
| `providers` | `id`, `name`, `endpoint`, `region`, `force_path_style`, `access_key_id`, `secret_ref`, `session_ref`, `scope_json`, `created_at` |
| `buckets` | `provider_id`, `name`, `posture_json`, `posture_at`, `first_seen`, `last_seen` |
| `issues` | `id`, `provider_id`, `bucket`, `code`, `severity`, `status`, `opened_at`, `resolved_at`, `last_seen_at`, `recurred` |
| `issue_events` | `id`, `issue_id`, `conversation_id`, `kind`, `at`, `detail_json` |
| `notes` | `id`, `scope`, `ref`, `text`, `author`, `created_at` |
| `audit` | `id`, `conversation_id`, `tool`, `target`, `outcome`, `at` |
| `task_meta` | `conversation_id`, `title`, `created_at`, `updated_at` |
| `datasets` | `id`, `conversation_id`, `kind`, `path`, `rows`, `bytes`, `created_at` |
| `search_docs` | `conversation_id`, `entry_id`, `kind`, `text`, `at` — derived index |

`search_docs` is rebuilt per conversation when it settles and backfilled at
startup. It stores the request text, the current verdict (`entry_id =
'verdict'`) and one row per finding (`entry_id = 'f:<finding key>'`, so several
findings from one tool call stay distinct). Deleting a task deletes its rows.
Nothing else reads it.

`secret_ref` and `session_ref` are vault references (ciphertext), never plaintext.
`posture_json` stores status enums and booleans only — no policy document, no
account id, no ARN beyond a destination bucket name.

## pi tables

pi-durable creates its own tables in the same database under the prefix `pi_`
(`SqliteStorage.open(database, { prefix: 'pi_' })`). Do not query them directly;
use `conversation.viewState()` / `watch()`.

Entry kinds the window understands:

| Kind | Meaning |
|---|---|
| `sa.user` | a Direction; data `{ text, attachments }` |
| `pi.assistant` | model output; the text is projected, `model` is not sent |
| `pi.tool-result` | a tool result; `details` is `{ target, note, view, ms }` |
| `pi.compaction` | compaction divider |
| `sa.notice` | an app notice; data `{ text, tone, action? }` |

## Datasets

One SQLite file per import at `tasks/<conversation>/datasets/<id>.sqlite`.
`access_logs` and `inventory_objects` hold redacted, normalized rows. Imports are
capped at 2,000,000 rows; a larger file is imported up to the cap and reported as
truncated. Dataset files are never loaded into the model context.

## Retention

Tasks, entries, issues and notes persist until the user deletes the task or the
account. Deleting a task is a real purge in one transaction: `task_meta`,
`search_docs`, the task's `pi_conversations` / `pi_entries` / `pi_tasks` /
`pi_submissions` / `pi_documents` / `pi_document_revisions` rows, datasets, audit
events, and `tasks/<conversation>/` on disk (uploads included). Issue events keep
history with `conversation_id` set to null. There is no import from earlier
versions of the app.
