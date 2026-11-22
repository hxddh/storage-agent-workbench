# Product

Storage Agent is an agent that looks after object storage and the cloud
around it, on the user's own machine. You talk with it; it reads the account
with read-only tools and answers in its own words. It keeps what it learns in
a workspace of its own, works on a schedule when asked to watch something,
and proposes changes that run only when you approve them. Each task is one
conversation. The app gives the agent a few general capabilities and the
boundaries around them, and shows each call where it happened. It decides
nothing about the storage: no rules, no findings, no verdict, no report and no
next-step prompt.

## Surfaces

1. **Task list**: new task, search, pinned / today / earlier groups, task
   state and relative time, rename, pin, delete, and Settings. The task open at
   quit opens at launch.
2. **Home**: the accounts, and what the agent keeps in front of the user —
   its inbox, its board and its schedules.
3. **Task**: one conversation, in order. The composer stays at the foot.
4. **Settings**: a full-screen sheet, closed with the **X** at its top left,
   for the model, storage accounts, the workspace and appearance.

The composer sits at the foot of Home and of a task. It sends a message, a
steer while the agent works, or a follow-up in the same task. An unsent draft
is kept locally per task. Without a model the composer is disabled and says
`Set up a model to ask a question.`

## Home

- The title, `What should I check?`.
- The accounts the agent can read, one row each: its name and where it
  answers (the endpoint's host, or `AWS`). Without an account, one line
  instead: `No account yet. Add one, then ask.`, or, before a model exists,
  `The agent needs a model to read your storage. Set one up and add an
  account.`
- **Add an account**, and **Set up a model** while there is no model. With an
  account but no model, the hint `Set up a model to ask a question.`
- Before a model exists, models running in Ollama or LM Studio, each a
  one-click `Use <model>`.
- **From your agent**: the inbox of what the agent told the user with
  `notify`, the latest eight, newest first. Clicking an entry marks it read and opens its task;
  **Mark all read** clears the unread marks.
- **Board**: every view the agent pinned as a `board/*.view.json` file in its
  workspace, newest first, drawn like a view in the conversation. The agent
  refreshes a view by writing the file again.
- **Scheduled**: each schedule, with its cadence, its next run and its token
  budget per run. Clicking one opens its task; **Cancel** (a second click
  confirms) removes it.
- In a narrow window, where the task list is an overlay, up to five recent
  tasks.

Each of the inbox, board and schedules appears only when it holds something.
Home has no canned prompt and starts nothing. To learn what an account holds,
ask.

## A conversation

- The message is recorded at once; the turn is durable and survives a restart.
- While the agent works, its steps appear below the message in order. A tool
  call appears when it starts, open, with its progress; it settles in place
  and folds to one line. A provider reasoning summary is a `Thought` step.
  Failed, refused and stopped calls stay in order.
- Every step can show exactly what the agent received from that call.
- The agent's text is Markdown and streams in as it is written. The agent may
  link a call as `[1](#ev-<id>)`; clicking the link opens that step in place.
  A link that matches no call is shown as plain text with a quiet tooltip. The
  app does not check names or rewrite the text.
- **Enter** while the agent works steers the current turn; the steer carries
  its files and `@` focus and shows as a dashed message where it was said.
  **Stop** (⌘.) keeps what was read and writes `Stopped. What was read is
  kept.` with **Continue**, which sends `Continue.` after a `Continued this
  task` divider.
- A turn that fails or ends without an answer becomes one notice with
  **Retry**, which sends the last user message again with its files and focus.
  A reply cut at the model's output limit says so where it stops. A scheduled
  run that reaches its token budget says `This scheduled run stopped at its
  token budget. What was read is kept.` with **Continue**. Otherwise the agent
  works until it answers or the user stops it.
- A change or a settings proposal is a card in the conversation with
  **Approve** and **Reject**; an applied change has **Roll back**. A file the
  agent writes under `exports/` is a **Save <name>…** link that opens the
  system save dialog.
- A turn that finishes while the window is in the background sends one system
  notification, unless Settings turns it off. A scheduled task's runs do not;
  they reach the user only through the agent's `notify`. The dock badge or
  taskbar progress shows work in flight.
- A turn uses the task's model when one is chosen in the conversation's
  **Model** select, otherwise the default model in Settings. The select offers
  every model saved in Settings — each keeps its own key and context window —
  and the models running on this machine, which need no key and run with the
  window their server reports (4,096 tokens unless the model is loaded with
  more). A model whose window is under 16,384 tokens is refused with how to
  load it with more. A model with a small window gets smaller result pieces
  and earlier compaction.
- The conversation's header shows the tokens the task has spent, its child
  agents included; hovering shows input, output and cache reads.
- A task with more than 200 entries opens at the latest and offers **Load
  earlier entries** at the top.

## What the agent can do

The agent decides which tools to use; the prompt does not list them or
prescribe a workflow, and each tool describes itself. The full contracts are
in [tools.md](tools.md).

- **`call`**: one read-only operation of a bundled AWS SDK client, with its
  input as the SDK names it. The result is the response as JSON, or the error
  code, HTTP status and message. A 404 such as `NoSuchBucketPolicy` is an
  answer. A streamed `GetObject` body is written to the task folder with a
  64 KiB preview and a `ref`, up to `max_bytes` (default 1 MiB, the agent's
  to raise).
- **`query`**: a JavaScript script for questions that span more than one call:
  every object in a bucket, every bucket, an inventory, an attached log, every
  log under a prefix. Its primitives include `call()` (bodies whole),
  `read()`, `dataset()` and `inventory()` (every column of the source;
  `dataset({scope: 'user'})` keeps one across tasks), `sql()`, `datasets()`,
  `history()` (earlier tasks), `discover()`, `workspace()`, `run()` (a
  workspace script) and `render()` (a view). It returns rows, a view or any
  JSON. It has no network, filesystem, process, timer or model access.
- **`probe`**: one unsigned HEAD, GET or OPTIONS, with any headers but
  credentials, to the account's endpoint or any public host: addresses,
  status, headers, TLS certificate and timing. A CORS preflight is one probe.
- **`more`**: every result is kept; `more` reads any stretch of one again, of
  an object body, an attached file, a workspace file or a bundled skill. An
  image is shown to a model that takes images.
- **`workspace`**: the agent's own folder across tasks — notes, skills,
  datasets, scripts, the board, exports — and its own `db.sqlite`.
- **`self`**: what model it runs on, what this task spent, the accounts and
  their settings, its schedules, the app version and the date. It can rename
  or pin its task, and propose an account's scope or allowing changes.
- **`schedule`**: a prompt that runs on its own, once or on a cadence, in its
  own task, within a token budget.
- **`notify`**: a system notification and an inbox entry, once per run.
- **`change`**: propose one reversible bucket-configuration write for the user
  to approve.
- **`delegate`**: give a self-contained investigation to a child agent with the
  same tools, scope and task files. Its steps show live inside the delegate
  step; several run at once; stopping the task stops them; a question it would
  ask comes back to the parent.
- **`ask`**: a question with optional answer buttons. The turn ends until the
  user answers.

Who can reach a bucket, whether it is public, what changed and who changed it
are the agent's to work out from these reads. Every identifier reaches it as
the service returned it, so it can compare an account id in a policy with its
own (`sts GetCallerIdentity`).

The agent knows its trade from **skills**: Markdown notes on public access,
cross-account access, encryption, identities and keys, change history, cost
and lifecycle, data at scale, S3-compatible endpoints and proposing changes.
The prompt lists every skill by name and description; the agent reads one
when it decides to. It can write its own in the workspace's `skills/`; those
are listed as untrusted data and never replace a bundled skill.

## The workspace

The workspace is a folder, `<data>/workspace/`, that the agent owns across
every task and the user can open. By convention it holds `notes/` (what the
agent learned about the accounts and the user's decisions), `skills/`,
`data/` (kept datasets), `scripts/` (checks a `query` can run again),
`board/` (views pinned on Home), `exports/` (files for the user) and
`db.sqlite` (the agent's SQL database). The agent organises it as it sees
fit. Secrets are redacted before anything is written. The prompt says which
folders hold files, not what they say; the agent reads what it needs. The app
never clears the workspace.

## Schedules

Asked to watch something, the agent creates a schedule: a name, the prompt
each run starts with, and when — once at a time, every few minutes or hours,
daily or weekly, in local time. Each run is a turn in the schedule's own task,
`Scheduled: <name>`, which the user can open, steer or stop. Nobody watches a
run, so it stops at its token budget (100,000 unless the schedule names
another) while its task is not open; opening it lifts the budget. A run missed
while the app was closed runs once when it opens.

With work scheduled, closing the last window on Windows and Linux leaves the
app running in the background so runs happen. Settings → Appearance can open
the app at login in the background, with no window; launching it again, or
clicking a notification, opens the window.

## Changes

Asked for a fix, the agent can do one of two things:

- **On an account that allows changes**, propose it with `change`. Only
  reversible bucket configuration can be changed: public access blocks, bucket
  policy, ownership controls, encryption, versioning, lifecycle, CORS,
  logging, tags and the bucket ACL, and the account-wide public access block.
  Before the card is shown the app reads what the change would replace. The
  card shows the exact call, the state now and after, and the agent's reason.
  **Approve** (confirmed with a second click) runs exactly that call;
  **Reject** does not. Either way the agent gets the outcome as the user's next
  message and reads again to verify. **Roll back** puts back what was there,
  at once, after a second click.
- **Otherwise**, write the change (an AWS CLI command, a policy, a lifecycle
  document) in its own Markdown for the user to apply.

A scheduled run can propose a change; nothing runs until a person approves
it. The prompt tells the agent never to claim a change was made unless the
user approved it and a later read shows it.

## Saving a task

The overflow menu at the top of the conversation holds **Save as…**
(Markdown: the messages, the agent's text and reasoning, and each call with
what the agent received), **Copy link**, **Export sources** (JSON: the task,
the conversation and usage) and **Save PDF** (the window with every step
open). Each agent text has **Copy answer** on hover.

## Search

⌘K focuses the sidebar search. It covers task titles, the user's messages
(steers included) and the agent's text, and returns at most 20 hits. A message
or text hit opens its task at that message. Queries of three or more characters
use FTS5 trigram BM25 ranking with user text ahead of answers; shorter queries,
including CJK substrings, use `LIKE`.

## Model fit

Settings fetches the provider's model list. The context window is what the
list states for the model, else the catalog's figure for its id (unknown
models get 128k), and reasoning is on at medium for known reasoning models and
off otherwise. The output budget is the model's own maximum, learned from its
provider on the first run, and at most a quarter of the window. Compaction is
sized to the window. Every model gets the same tools and prompt. A saved key
is sent only to the provider and base URL it was saved for.

## Settings

- **Model**: provider (OpenAI, Anthropic, OpenAI-compatible), model, base URL
  and API key. Pasting a key fetches the provider's models. Save stores the
  model; Test checks the values in the form, saved or not.
- **Storage accounts**: name, endpoint, region, path-style addressing, access
  keys (with an optional session token) or an AWS profile, an optional bucket
  scope, and **Allow changes I approve** (off by default) with an optional AWS
  profile used for changes only. Each account shows its endpoint or `AWS`, its
  region, its masked key id or profile and whether changes are allowed, with
  Test, Edit and Remove.
- **Workspace**: **Open workspace folder**; every file and folder with its size
  and date, each with Open and Delete; kept datasets with **Forget**; and the
  skills, bundled or the user's.
- **Appearance**: English or Chinese, system / light / dark theme, the
  background-notification switch, and opening at login in the background.
- The installed version and update state sit at the foot of the rail; a
  missing update feed says so.

## Other agents

`storage-agent --mcp` runs the app headless as an MCP server over stdio.
Another agent (an editor, Claude Code, a CI job) can use `call`, `query`,
`probe`, `more` and the workspace's read actions, with the same accounts,
scope, redaction and envelope. Changes, schedules and notifications stay in
the window.

## Known limits

- The tools return what the APIs answer. Whether that adds up to "public" or
  "safe" is the agent's judgement, and the agent can be wrong; every read it
  relied on is in the conversation to check.
- An endpoint answers what it implements; an operation it does not implement
  comes back as its own error ([capabilities.md](capabilities.md)).
- Paged APIs return one page per call; the agent decides whether to read
  further pages, or pages through in `query`.
- Delegation is foreground: the parent waits for the child's answer.
- Changes cover reversible bucket configuration only; anything else is text
  for the user to apply.
- On macOS the app keeps running after its last window closes, as macOS apps
  do; elsewhere it stays only when work is scheduled or it opens at login.
- Attachments: at most ten files at a time, 4 GiB each.
- The sidebar shows the 500 most recently updated tasks.
