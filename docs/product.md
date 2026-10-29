# Product

Storage Agent is a local, read-only agent for object storage. You talk with it;
it reads the account with read-only tools and answers in its own words. Each
task is one conversation. The agent reads, judges and says what it found; the
app gives it tools that return what the storage APIs return, enforces the
safety boundaries and shows each call where it happened. The app decides
nothing about the storage: no rules, no findings, no verdict, no report. It is
not a console, a dashboard or a ticket system.

## The surfaces

1. **Task list** — new task, search, pinned/today/earlier groups, task state and
   relative time, rename, pin, delete and Settings. A new task starts empty. The
   task open at quit opens at launch.
2. **Task** — one conversation: the user's messages and, between them, what the
   agent did and said, in order. The composer stays at the foot.
3. **Settings** — a full-screen sheet closed with the **X** at its top-left, for
   the model, storage accounts, memory, language, theme and notifications. It is
   one sheet, not a wizard.

The composer is docked at the foot of the window on Home and in a task. It sends
a message, a steer while the agent works, or a follow-up in the same task. An
unsent draft is kept locally per task and restored when the task reopens.
Without a model the composer is disabled and says `Set up a model to ask a
question.`

## Home

Home is a starting point, not a dashboard. It holds:

- the title, `What should I check?`;
- the accounts the agent can read, one row each with its name and provider
  kind, and nothing more. Without an account, one line instead:
  `No account yet. Add one, then ask.`, or, before a model exists, `The agent
  needs a model to read your storage. Set one up and add an account.`;
- **Add an account**;
- **Set up a model** when there is no model, and, with an account but no model,
  the hint `Set up a model to ask a question.`;
- before a model exists, models already running in Ollama or LM Studio, each a
  one-click `Use <model>`;
- on narrow windows, where the task list is an overlay, recent tasks, five at
  most, as quiet one-line links; the desktop sidebar already holds them.

Home has no canned prompt and starts nothing. To learn what an account holds,
ask.

## A conversation

- The message is recorded immediately; the turn is durable.
- While the agent works, its steps appear below the message in order. A tool
  call appears when it starts, open, with its real progress; it settles in
  place and folds to one line. A provider reasoning summary appears as a
  `Thought` step; when the provider returns none, the open step says so.
  Completed, failed, refused and stopped calls stay in order.
- Every step can show exactly what the agent received from that call, so the
  page never shows more than the agent saw.
- The agent's text is normal Markdown, and a turn can hold several texts
  between calls. Text streams in while it is written. The agent may link a call
  as `[1](#ev-<id>)`; clicking the link opens that step in place. There is no
  answer tool and no report block language, and the app does not check, mark or
  rewrite the text.
- **Enter** while the agent works steers the current turn; the steer carries
  its files and `@` focus with it and shows as a dashed message where it was
  said. **Stop** (or ⌘.) keeps what was read and writes `Stopped. What was read
  is kept.` with **Continue**; Continue sends `Continue.` in the same task after
  a `Continued this task` divider.
- A turn that fails or ends without an answer becomes one notice with
  **Retry**; Retry sends the last user message again with its files and focus.
  There is no round ceiling: the agent works until it answers or the user
  stops it. A reply cut at the model's output limit says so where it stops.
- A follow-up is the next message in the same thread.
- Long tasks survive a restart; pi resumes interrupted work.
- A turn that finishes while the window is in the background sends one system
  notification (Settings can turn it off). The dock badge or taskbar progress
  shows work in flight.
- A turn uses the task's model when one is chosen in the conversation's
  **Model** select, otherwise the model in Settings; reasoning level and context
  window are inferred from that model. The provider key always comes from the
  saved model.
- A task with more than the initial 200 entries offers **Load earlier entries**
  at the top instead of silently dropping them.

## Clarifying questions

The agent may call `ask` with a question and, if it wants, up to six options.
The question is an agent message; while it waits, each option is a button that
sends that option as the next message, and typing an answer in the composer
works the same way.

## What the agent reads

The tools return data, not judgements.

- **`call`** — one read-only operation of any AWS SDK client the app bundles:
  `s3`, `s3control`, `sts`, `iam`, `organizations`, `kms`, `accessanalyzer`,
  `cloudwatch` and `cloudtrail`. Any operation named Get, List, Head, Describe,
  Lookup, Search, Select or Simulate runs, with its input as the SDK names it;
  nothing else does, and the few reads that hand out credentials are refused.
  The result is the service's response as JSON (a policy document parsed), or
  its error code, HTTP status and message. A 404 such as `NoSuchBucketPolicy` is
  an answer, not a failure to hide. A `GetObject` body is read up to
  `max_bytes` (default 1 MiB): text as text, anything else as base64. A
  custom-endpoint account answers every service at its own endpoint; its
  credentials are never sent to AWS. Its step opens as the response's JSON.
- **`probe`** — one unsigned HEAD or GET to the account's endpoint or a host
  under it: resolved addresses, HTTP status, headers, the TLS certificate and
  timing. It carries no credentials and marks nothing as ok or failed.
- **`more`** — a result longer than 24,000 characters reaches the agent as its
  first piece; the whole result is kept in the task folder and `more` reads on
  from an offset. Nothing a tool returned is out of the agent's reach.

Who can reach a bucket, whether it is public, what changed and who changed it
are the agent's to work out from these reads and say. The app evaluates no
policy, merges no grants and estimates no cost. Account ids never reach the
agent: `scrub()` replaces each 12-digit number with `<account>`. The agent
writes `<account>` where the caller's id belongs, and `call` fills it in from
STS for that call only (S3 Control's `AccountId` always).

## Changes

Asked for a fix, the agent writes the change — an AWS CLI command, a policy, a
lifecycle document — in its own Markdown, for the user to apply. The app never
runs it and has no Apply button. The prompt says never to claim a change was
made: only a later read shows it. To learn whether a change landed, the user
says so and the agent reads again.

## Inventory and open questions

`query` exists for questions that span more than one call carries: every
object in a bucket, every bucket, an inventory, an attached log. The script
runs in a QuickJS sandbox with four read-only primitives:

- `call()` — any read the `call` tool makes, under the same rules;
- `dataset()` — imports an attached access log or inventory into a local
  SQLite table, client IPs masked;
- `inventory()` — imports every file of a bucket's latest S3 Inventory
  manifest into one dataset, and gives the manifest date;
- `sql()` — one read-only SELECT (or WITH … SELECT) over a dataset's `rows`.

The script runs until it returns or the user stops it. Its memory defaults to
1024 MB, which the agent can raise with `memory_mb`; that default protects the
machine, not the storage. The query's step shows the returned rows (up to
10,000 in the window; the agent gets all of them), a bar chart when the rows
have one label and one number, the script and its output. It never accepts
network, filesystem, process, timer or module access.

## Memory

The agent's memory is its notes. `note` saves a fact about the storage, an
account or a bucket, with secrets redacted, and forgets a note of its own that
no longer holds. The prompt's memory digest names the accounts (their ids are
tool arguments) and every note, newest first, with its id and whether the user
wrote it. Notes are what the agent chose to remember, not a fresh read; when to
rely on them is the agent's. Settings lists every note, and any of them can be
forgotten there.

There is no remembered bucket posture, Issue list, reading history or
background monitor. Deleting a task purges its conversation, entries, datasets,
uploads, search rows, audit rows and task directory. Removing an account
removes its account and bucket notes. See [data-model.md](data-model.md).

## Saving a task

One overflow menu at the top of the conversation holds **Save as…** (Markdown:
the messages, the agent's text and one line per call), **Copy link**, **Export
sources** (JSON: the task, the projected conversation and usage) and **Save
PDF**, which prints the window with every step open. Each agent text has its own
**Copy answer** on hover.

## Search

⌘K focuses the sidebar search. It covers task titles, the user's messages
(steers included) and the agent's text. A message or text hit opens its task and
scrolls to that message. Title search reads `task_meta`; the rest reads the
derived `search_docs` index. Search uses FTS5 trigram ranking, with a LIKE
fallback for short CJK queries, and returns at most 20 hits.

## Model fit

The provider reports the model list in Settings. The context window is inferred
(unknown models fall back to 128k), and reasoning is on at medium for known
reasoning models, off otherwise. The output limit is the model's own maximum:
once per model per launch, a one-word request offers the whole context window,
and a provider that refuses names its maximum. Every model gets the same tools
and prompt; nothing is tuned down for a smaller one.

## Settings

- **Model** — provider, model id, base URL and API key. Pasting a key fetches the
  provider's models automatically; the manual fetch remains only when no key is
  present. Save stores it; Test checks the values in the form, even before
  saving.
- **Storage accounts** — provider kind (auto or explicit), endpoint, region,
  keys or AWS profile, optional bucket scope and path-style addressing. The
  account list shows the masked key id or profile name.
- **Memory** — a note age filter and every note. Notes can be forgotten here.
- **Appearance** — English/Chinese, system/light/dark, notification switch.
- **Version** — installed version and the update state; a missing feed says so
  instead of failing silently.

## Known limits

- The tools return what the APIs answer. Whether that adds up to "public" or
  "safe" is the agent's judgement, and the agent can be wrong; every read it
  relied on is in the conversation to check.
- A custom endpoint answers what it implements; an operation it does not
  implement comes back as its own error.
- Paged APIs are read a page at a time, with the service's own page size; the
  agent decides whether to read further pages, or pages through in `query`.
- Attachments are limited to ten files and 4 GiB each.
- There is no scheduled check, background watch, demo storage, dashboard,
  second window or import from an earlier app version.
