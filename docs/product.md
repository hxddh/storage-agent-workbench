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
  Completed, failed, refused, stopped and timed-out calls stay in order.
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
  A turn that made 100 rounds of tool calls says so; its next call does not
  run. A reply cut at the model's output limit says so where it stops.
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

The tools return data, not judgements. A read returns each API's answer as
`{ status, value }` or `{ status, error }`, with the status `available`,
`not_configured`, `access_denied`, `provider_unsupported`, `missing`,
`region_mismatch` or `error`. A denied read is a denied read, with the
provider's error; it is never turned into an empty or clean value.

- **`buckets`, `objects`, `object`** — the bucket list; keys, versions or
  incomplete multipart uploads a page at a time (up to 1,000 rows, with a `next`
  token); one object's metadata, tags, ACL and a bounded text preview. A large
  body is never downloaded.
- **`config`** — one bucket's configuration, section by section: `location`,
  `policy` (parsed), `policy_status`, `public_access_block`, `acl`,
  `ownership`, `encryption`, `versioning`, `object_lock`, `lifecycle`,
  `replication`, `cors`, `website`, `logging`, `notification`, `inventory` and
  `tagging`. The agent can ask for some sections or all of them. Its step opens
  as the sections with their status and JSON.
- **`account`** — account-level data on AWS: the account-wide public access
  block, one page of IAM authorization details (users, groups, roles and their
  policies), the SCPs that apply through the OU chain, a KMS key policy, Access
  Analyzer findings, CloudWatch daily storage size by storage type and object
  count for a bucket (default 14 days), and one page of CloudTrail management
  events naming a bucket (default 90 days). Paged reads return a token for the
  next page. On another provider it answers `provider_unsupported` without
  calling anything.
- **`probe`** — one endpoint check: reach, TLS, latency, bucket region and
  path-style addressing.

Who can reach a bucket, whether it is public, what changed and who changed it
are the agent's to work out from these reads and say. The app evaluates no
policy, merges no grants and estimates no cost. Account ids never reach the
agent: `scrub()` replaces each 12-digit number with `<account>`, and the id STS
returns is used only as the argument of the account-wide block and SCP reads.

## Changes

Asked for a fix, the agent writes the change — an AWS CLI command, a policy, a
lifecycle document — in its own Markdown, for the user to apply. The app never
runs it and has no Apply button. The prompt says never to claim a change was
made: only a later read shows it. To learn whether a change landed, the user
says so and the agent reads again.

## Inventory and open questions

`query` exists for questions that do not fit one bucket or one object. The
script runs in a QuickJS sandbox with nine read-only primitives: `buckets`,
`list`, `head`, `config`, `account`, `inventory`, `dataset`, `aggregate` and
`rows`. `config` and `account` are the tools' own reads. The query's step shows
the returned rows (at most 500, all of them sent to the model), a bar chart
when the rows have one label and one number, the script and its output.

When a bucket has S3 Inventory, `inventory` reads the latest manifest and one
bounded page (default 100 rows, maximum 1,000) or imports every manifest file
with `full: true`. A page reads CSV up to 32 MiB or Parquet up to 16 MiB; a
larger file is reported, not silently cut. Full import is bounded to 1,000
files, 128 MiB per file, 512 MiB total and 2,000,000 rows. The result states the
manifest date and whether it was truncated.

An attached access log or inventory is imported with `dataset`, then read with
whitelisted `aggregate` metrics (at most 1,000 groups) or with `rows`, a page of
at most 1,000 redacted rows with client IPs masked. There is no SQL.

Code mode budgets are 2,000 calls, 500,000 listed items, 120 seconds and 256 MiB
per script. It never accepts network, filesystem, process, timer or module
access.

## Memory

The agent's memory is its notes. `note` saves a fact about the storage, an
account or a bucket, with secrets redacted. The prompt's memory digest names
the accounts (their ids are tool arguments) and the first 12 notes, with the
total count. Notes are what the agent chose to remember, not a fresh read; when
to rely on them is the agent's. Settings lists the 100 most recent notes, and
any of them can be forgotten there.

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
reasoning models, off otherwise. Every model gets the same tools, prompt and
100-round runaway ceiling; nothing is tuned down for a smaller one.

## Settings

- **Model** — provider, model id, base URL and API key. Pasting a key fetches the
  provider's models automatically; the manual fetch remains only when no key is
  present. Save stores it; Test checks the values in the form, even before
  saving.
- **Storage accounts** — provider kind (auto or explicit), endpoint, region,
  keys or AWS profile, optional bucket scope and path-style addressing. The
  account list shows the masked key id or profile name.
- **Memory** — a note age filter and the notes the agent wrote. Notes can be
  forgotten here.
- **Appearance** — English/Chinese, system/light/dark, notification switch.
- **Version** — installed version and the update state; a missing feed says so
  instead of failing silently.

## Known limits

- The tools return what the APIs answer. Whether that adds up to "public" or
  "safe" is the agent's judgement, and the agent can be wrong; every read it
  relied on is in the conversation to check.
- Account-level reads exist on AWS only. S3-compatible providers answer what
  they implement; the rest comes back `provider_unsupported`.
- IAM and CloudTrail are read a page at a time; the agent decides whether to
  read further pages.
- A code-mode script runs under the call, listing, time and memory budgets above.
- Attachments are limited to ten files and 4 GiB each.
- There is no scheduled check, background watch, demo storage, dashboard,
  second window or import from an earlier app version.
