# Product

Storage Agent is a local, read-only agent for object storage and the cloud
around it. You talk with it; it reads the account with read-only tools and
answers in its own words. Each task is one conversation. The agent reads,
judges and says what it found; the app gives it tools that return what the
services return, enforces the safety boundaries and shows each call where it
happened. The app decides nothing about the storage: no rules, no findings, no
verdict, no report and no next-step prompt.

## Surfaces

1. **Task list**: new task, search, pinned / today / earlier groups, task
   state and relative time, rename, pin, delete, and Settings. The task open at
   quit opens at launch.
2. **Task**: one conversation, in order. The composer stays at the foot.
3. **Settings**: a full-screen sheet, closed with the **X** at its top left,
   for the model, storage accounts, memory, methods and appearance.

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
- In a narrow window, where the task list is an overlay, up to five recent
  tasks.

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
  A reply cut at the model's output limit says so where it stops. The agent
  works until it answers or the user stops it.
- A turn that finishes while the window is in the background sends one system
  notification, unless Settings turns it off. The dock badge or taskbar
  progress shows work in flight.
- A turn uses the task's model when one is chosen in the conversation's
  **Model** select, otherwise the model in Settings.
- A task with more than 200 entries opens at the latest and offers **Load
  earlier entries** at the top.

## What the agent can do

The agent decides which tools to use; the prompt names them but prescribes no
workflow. The full contracts are in [tools.md](tools.md).

- **`call`**: one read-only operation of a bundled AWS SDK client, with its
  input as the SDK names it. The result is the response as JSON, or the error
  code, HTTP status and message. A 404 such as `NoSuchBucketPolicy` is an
  answer. A streamed `GetObject` body is written to the task folder with a
  64 KiB preview and a `ref`, up to `max_bytes` (default 1 MiB, the agent's
  to raise).
- **`query`**: a read-only JavaScript script for questions that span more than
  one call: every object in a bucket, every bucket, an inventory, an attached
  log. Its primitives include `call()`, `discover()`, `dataset()`,
  `inventory()`, `memory()`, `render()` and `sql()`. It has no network,
  filesystem, process, timer or model access.
- **`probe`**: one unsigned HEAD or GET to the account's endpoint or a host
  under it: addresses, status, headers, TLS certificate and timing.
- **`more`**: a result longer than 24,000 characters reaches the agent as its
  first piece; `more` reads on from any offset. It also reads a stored object
  body.
- **`discover`**: the services and read operations available, the tools, and
  their contracts.
- **`render`**: a declarative view document (Markdown, table, chart, tree,
  timeline, diff, callout, key-value, code). The app renders it; the document
  is never HTML or code.
- **`memory`**: arbitrary JSON documents with keys, tags, task or user scope,
  list/get/query/delete. The agent decides when to recall; content is not
  injected into the prompt.
- **`tool`**: save, list, run and delete a reusable method: a JSON Schema and a
  read-only JavaScript body. A method can be task- or user-scoped.
- **`delegate`**: give a self-contained investigation to a child agent with the
  same read-only tools, scope and memory. Its steps show inside the delegate
  step; stopping the task stops it.
- **`ask`**: a question with up to six options. The turn ends until the user
  answers.

Who can reach a bucket, whether it is public, what changed and who changed it
are the agent's to work out from these reads. Account ids never reach the
agent: the caller's id becomes `<account>`, and the agent writes `<account>`
where the caller's id belongs.

## Changes

Asked for a fix, the agent writes the change (an AWS CLI command, a policy, a
lifecycle document) in its own Markdown, for the user to apply. The app never
runs it and has no Apply button. The prompt tells the agent never to claim a
change was made; only a later read shows it.

## Memory and methods

The agent's memory is its own `memory.sqlite`: JSON documents it chooses to
write, with a key, optional text and tags, and task or user scope. It can read,
list, query with one read-only SELECT, and forget. Settings lists every
document with its key and scope and can forget any of them. Memory is not
injected into the prompt; the digest says how many documents exist.

A method is a tool the agent wrote for itself: a JSON Schema and a read-only
JavaScript body. It runs in the same QuickJS sandbox as `query`, with the same
scope and no network, filesystem, process, timers or modules. Settings lists
methods and their code, and can delete one.

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

Settings fetches the provider's model list. The context window is inferred
from the model id (unknown models get 128k), and reasoning is on at medium for
known reasoning models and off otherwise. The output budget is the model's
own maximum, learned from its provider on the first run. Every model gets the same
tools and prompt.

## Settings

- **Model**: provider (OpenAI, Anthropic, OpenAI-compatible), model, base URL
  and API key. Pasting a key fetches the provider's models. Save stores the
  model; Test checks the values in the form, saved or not.
- **Storage accounts**: name, endpoint, region, path-style addressing, access
  keys (with an optional session token) or an AWS profile, and an optional
  bucket scope. Each account shows its endpoint or `AWS`, its region and its
  masked key id or profile, with Test, Edit and Remove.
- **Memory**: every document, its key and scope, with **Forget**.
- **Methods**: every agent-authored method, its scope, description and code,
  with Delete.
- **Appearance**: English or Chinese, system / light / dark theme, and the
  background-notification switch.
- The installed version and update state sit at the foot of the rail; a
  missing update feed says so.

## Known limits

- The tools return what the APIs answer. Whether that adds up to "public" or
  "safe" is the agent's judgement, and the agent can be wrong; every read it
  relied on is in the conversation to check.
- An endpoint answers what it implements; an operation it does not implement
  comes back as its own error ([capabilities.md](capabilities.md)).
- Paged APIs return one page per call; the agent decides whether to read
  further pages, or pages through in `query`.
- Delegation is foreground: the parent waits for the child's answer.
- Attachments: at most ten files at a time, 4 GiB each.
- The sidebar shows the 500 most recently updated tasks.
