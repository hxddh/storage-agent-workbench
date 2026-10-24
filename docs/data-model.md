# Data model

## Application tables (`storage-agent.db`)

`user_version` is the schema version (head **5**); migrations are append-only in
`main/db.ts`. Version 3 dropped the unused `watch` table and `task_meta.origin`.
Version 4 added account auth kinds, bucket region and disappearance, Issue
evidence and the accepted state. Version 5 added the account posture
(`providers.account_json`, `account_at`).

| Table | Columns (essential) |
|---|---|
| `providers` | `id`, `name`, `endpoint`, `region`, `force_path_style`, `auth` (`keys`/`profile`), `profile`, `access_key_id`, `secret_ref`, `session_ref`, `scope_json`, `account_json`, `account_at`, `created_at` |
| `buckets` | `provider_id`, `name`, `posture_json`, `posture_at`, `region`, `first_seen`, `last_seen`, `gone_at` |
| `issues` | `id`, `provider_id`, `bucket`, `code`, `severity`, `status` (`open`/`resolved`/`accepted`), `detail`, `opened_at`, `resolved_at`, `accepted_at`, `last_seen_at`, `recurred` |
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

`secret_ref` and `session_ref` are vault references (ciphertext), never plaintext;
a profile account stores an empty `secret_ref` and only the profile name.
`posture_json` stores status enums, booleans and capacity numbers (`size_bytes`,
`objects`, `monthly_usd`, `growth_bytes`, `capacity_at`) — no policy document,
no account id, no ARN. `account_json` holds the account block's status and
switches only. The account rule's Issue uses the empty string as its bucket. `issues.detail` is a short phrase from the rule ("Off:
RestrictPublicBuckets"), never a document. `issue_events.kind` is `opened`,
`resolved`, `recurred`, `gone`, `accepted` or `reopened`.

A bucket with `gone_at` is left out of every listing and the digest; seeing it
again clears the mark.

## pi tables

pi-durable creates its own tables in the same database under the prefix `pi_`
(`SqliteStorage.open(database, { prefix: 'pi_' })`). Do not query them directly;
use `conversation.viewState()` / `watch()`.

Entry kinds the window understands:

| Kind | Meaning |
|---|---|
| `sa.user` | a request; data `{ text, attachments }` |
| `sa.continue` | the user resumed a stopped run; a boundary, not a question |
| `pi.user` | the harness's own message to the model (a grounding correction); not shown |
| `pi.assistant` | model output; the text is projected, `model` is not sent |
| `pi.tool-result` | a tool result; `details` is `{ target, note, view, ms, status }` |
| `pi.compaction` | compaction divider |
| `sa.notice` | an app notice; data `{ code, text, tone, action? }`, worded by the window |

pi's `pi.usage` document is read for the task's token receipt.

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
