# Data model

## Application tables (`storage-agent.db`)

`user_version` is the schema version; migrations are append-only in `main/db.ts`.

| Table | Columns (essential) |
|---|---|
| `providers` | `id`, `name`, `endpoint`, `region`, `force_path_style`, `access_key_id`, `secret_ref`, `session_ref`, `scope_json`, `created_at` |
| `buckets` | `provider_id`, `name`, `posture_json`, `posture_at`, `first_seen`, `last_seen` |
| `issues` | `id`, `provider_id`, `bucket`, `code`, `severity`, `status`, `opened_at`, `resolved_at`, `last_seen_at`, `recurred` |
| `issue_events` | `id`, `issue_id`, `conversation_id`, `kind`, `at`, `detail_json` |
| `notes` | `id`, `scope`, `ref`, `text`, `author`, `created_at` |
| `audit` | `id`, `conversation_id`, `tool`, `target`, `outcome`, `at` |
| `watch` | `provider_id`, `enabled`, `interval_hours`, `last_run_at` |
| `task_meta` | `conversation_id`, `title`, `origin`, `created_at`, `updated_at` |
| `capability` | `provider_id`, `name`, `verdict`, `checked_at` |
| `datasets` | `id`, `conversation_id`, `kind`, `path`, `rows`, `bytes`, `created_at` |

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
| `sa.notice` | an app notice; data `{ text, tone }` |

## Datasets

One SQLite file per import at `tasks/<conversation>/datasets/<id>.sqlite`.
`access_logs` and `inventory_objects` hold redacted, normalized rows. Imports are
capped at 2,000,000 rows; a larger file is imported up to the cap and reported as
truncated. Dataset files are never loaded into the model context.

## Retention

Tasks, entries, issues and notes persist until the user deletes the task or the
account. Deleting a task removes its metadata; pi's entries remain in the pi
tables (there is no cross-store cascade in v1). There is no import from earlier
versions of the app.
