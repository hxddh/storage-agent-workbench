# Product

Storage Agent answers questions about object storage by reading it. It is not a
console, a dashboard, a ticket system or a chat product: it is a task list and a
document.

## The three surfaces

1. **Task list** — every task, newest first, with a state dot. New task, rename,
   delete, Settings. Nothing else.
2. **Task** — the request, the tool calls it caused, the answer. One scroll.
   A tool row expands in place to its rendered result: a table, findings, a
   probe, a fix in three formats, a chart.
3. **Settings** — model, storage accounts, language and theme. A full-screen
   sheet, not a wizard.

The composer is docked at the foot of the window on every screen, including
Home. Home is an empty task: one heading, one hint when setup is missing.

## A task

- The user writes a Direction. It is recorded immediately; the run is durable.
- A tool call appears as a row the moment it starts, shows its real progress
  (`3 of 12 buckets`) and settles in place. Nothing waits for the end to appear.
- A partial answer streams as it is written; the call that produced it stays
  above it.
- When it settles, the calls remain as rows and the answer is the last block.
  There are no suggestions, next steps or follow-up chips.
- **Add to the request** (Enter while running) steers the run. **Stop** keeps
  what was written and offers **Continue**.
- A failure becomes one notice with **Retry**; no dialog.
- Long tasks survive a restart; pi resumes the interrupted work once.

## The answer contract

The model writes short prose: a lead sentence and at most two paragraphs. It
does not write headings, tables or long lists, and it does not restate data the
window already renders. Tool results carry a typed `view` that the window draws:
survey tables, issue lists, configuration findings, probe checks, fix formats
with an impact verdict, analysis tables and bar charts.

If a read was denied or unsupported, the answer says the question is open. It
never turns silence into "no problems found".

Tables and findings are flat sections in the document, separated by hairlines —
not cards inside cards. Every table has **Copy CSV** and **Save as…**; every
answer has **Copy** and **Save as…**.

## Search

⌘K focuses the sidebar search. It covers task titles, requests and answers.
Results show the matching fragment; opening one shows that task at the matching
message. A derived `search_docs` table is rebuilt when a task settles and
backfilled at startup; the search itself is `LIKE`, which handles Chinese
substrings (FTS trigram needs three characters).

## Issues

Seven deterministic rules open Issues from survey posture and configuration
reviews:

| Code | Severity | Rule |
|---|---|---|
| `public_exposure` | high | Bucket is publicly accessible |
| `wildcard_principal` | medium | Policy allows a wildcard principal |
| `cors_all_origins` | medium | CORS allows all origins |
| `no_default_encryption` | medium | No default encryption |
| `public_access_block_missing` | medium | Public access block not fully enabled |
| `no_abort_mpu` | medium | Incomplete multipart uploads are never cleaned up |
| `noncurrent_never_expire` | medium | Noncurrent versions never expire |

A rule is decided only by a read that could see it. An unreadable policy, ACL or
configuration leaves the rule undecided; it is never resolved by that silence.
The model does not open, close or re-grade an Issue.

## Fixes

`fix` generates the AWS CLI command, a Terraform resource and the API document,
targeting the account's endpoint and region. The bucket name must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,254}`; anything else has no safe fix. The impact
preview uses the recorded posture and says what it cannot tell. Storage Agent
never applies a fix.

## Watching

An account can be watched (off, 6 h, daily, weekly). A watch opens a task with a
shield in the list, asks the agent to survey and report what changed, and raises
a desktop notification when new Issues were opened by that run. Watches stop
when the model is not configured.
