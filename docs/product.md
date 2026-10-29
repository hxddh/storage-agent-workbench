# Product

Storage Agent is a local, read-only agent for object storage. You talk with it;
it reads the account with read-only tools, remembers what it read, and answers
in its own words. Each task is one conversation. The app supplies the
capabilities and the safety boundaries and shows each call where it happened;
it adds no report, verdict or coverage summary of its own. It is not a console,
a dashboard or a ticket system.

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

Home is a starting point, not a dashboard:

- the accounts the agent can read, one row each with its name and provider
  kind. Home shows no risk counts, coverage or verdict; asking is how you learn
  what an account holds;
- **Check account**, when a model is set;
- on narrow windows, where the task list is an overlay, recent tasks, five at
  most, as quiet one-line links; the desktop sidebar already holds them;
- the composer in its usual place.

With no account, the choices are **Try with demo storage** and **Add an
account**, plus **Set up a model** before a model exists. With an account but no
model, Home offers **Add an account** and **Set up a model** and says a model is
needed to ask a question; there is no Check account. Demo storage is in-process
and never added on its own. Without a model, **Try with demo storage** only adds
the demo account; with one, it adds the account and starts Check account. Local
models already running in Ollama or LM Studio can be chosen from Home or
Settings.

## Check account

**Check account** is a message to the agent, in a new task:

> Check my storage accounts: read every bucket, tell me which risks are open,
> and say what you could not read.

It is a turn like any other: the agent decides what to read, its calls appear as
steps, and it answers in its own words. The task title comes from the message.
It needs a model.

An account can opt into a daily or weekly scheduled check in Settings. While the
app is open and a model is set, a due account gets a new task titled
`Scheduled check · <account> · <time>` with the same kind of message, focused on
that account. It never writes storage. It is a snapshot, not a monitor; a closed
app performs no work. The account's latest reading row decides when the next
one is due.

The scripted, model-free check and re-check of 35.x were removed in 36.0.

## A conversation

- The message is recorded immediately; the turn is durable.
- While the agent works, its steps appear below the message in order. A tool
  call appears when it starts, open, with its real progress (`3 of 12
  buckets`); it settles in place and folds to one line. A provider reasoning
  summary appears as a `Thought` step; when the provider returns none, the open
  step says so. Completed, failed, refused, stopped and timed-out calls stay in
  order.
- The agent may publish a short plan; it appears as a `Plan` block among the
  steps. Within a turn only its newest version is shown. A plan is optional: a
  direct answer does not need one.
- The agent's text is normal Markdown, and a turn can hold several texts
  between calls. Text streams in while it is written. The agent may link a call
  as `[1](#ev-<id>)`; clicking the link opens that step in place. There is no
  answer tool and no report block language, and the app does not check, mark or
  rewrite the text.
- **Enter** while the agent works steers the current turn; the steer carries
  its files and `@` focus with it and shows as a dashed message where it was
  said. **Stop** (or ⌘.) keeps what was read and writes `Stopped. What was read
  is kept.` with **Continue**; Continue resumes the same task after a
  `Continued this task` divider, without a new question.
- A turn that fails or ends without an answer becomes one notice with
  **Retry**; Retry sends the last user message again with its files and focus.
  A turn that ran out of rounds says `The step budget ran out.`
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

When a request is genuinely ambiguous and the answer would change, the agent
may call `ask` once with one short question and 2–4 options. The question is an
agent message; while it waits, each option is a button that sends that option
as the next message. Typing an answer in the composer works the same way.

## Accepting a risk

Accepting a risk is the user's act. When the user asks, the agent calls
`accept_risk` with the bucket and rule code. The window shows a confirmation:
`Accept the risk “…” on …? It stays recorded as accepted until a reading proves
it fixed.` with **Accept risk** (or **Reopen** for an accepted one). Only that
click changes the Issue; the card then says `Accepted.` or `Reopened.`. If a
later reading proved the risk fixed, the card says so.

## Risks

Internally the durable entity is an `Issue`, in `open`, `resolved` or
`accepted` state. Rules open and close it from readings; the model never does.
A survey step's note says how many Issues the read opened and resolved
(`4 buckets · 1 new issue · 2 resolved`), and its result lists the open and
accepted risks it saw, grouped by bucket. Accepting survives later readings while
the risk is still observed. A bucket that a complete listing no longer shows
gets `gone_at`; its Issues resolve as `gone`.

There is no Findings or Not checked strip and no scope line. What a read could
not see is in that call's result (denied, unknown, pending, truncated,
undecided, permissions), and the prompt tells the agent to say it and never to
call the account clean while a read is open.

## Saving a task

One overflow menu at the top of the conversation holds **Save as…** (Markdown:
the messages, the agent's text and one line per call), **Copy link**, **Export
sources** (JSON: the task, the projected conversation and usage) and **Save
PDF**, which prints the window with every step open. Each agent text has its own
**Copy answer** on hover.

## Access evidence

`config` with `aspect: "access"` answers what the readings show about who can
reach a bucket. It combines:

- bucket policy statements, evaluated locally, including conditions and
  public/blocked status;
- bucket ACL grants;
- IAM users, groups and roles, their inline, attached and group policies,
  permission boundaries and role trust, evaluated locally;
- SCPs from the account, OU and root chain when Organizations permits;
- KMS key policy when the bucket uses SSE-KMS;
- Access Analyzer findings when an analyzer exists.

Identity grants are intersected with bucket-policy Denies and, when read, SCPs
and permission boundaries. Object and bucket actions are paired with their
matching resource form; ARNs are case-sensitive. A grant to another account is
evidence with an unread external identity policy, not a clean allow.

This is **grant evidence**, not one complete authorization decision. Policy and
ACL rows are not merged with every identity, SCP and condition into a single
yes/no. Conditions are shown but not evaluated; service principals, federated
identities and some external policies are not enumerated. The call's result
shows principal coverage (`evaluated / total`), undecided conditions and truncation.
A denied read is a blind spot, never an empty grant list.

The `principal()` code-mode primitive provides the reverse view over remembered
buckets and reports how many buckets it examined. It is bounded, not an
account-wide proof.

## Changes and attribution

A survey compares the new reading with the last remembered posture. It records
differences in policy, ACL, public access block, encryption, versioning,
lifecycle, logging, CORS and object ownership.

On AWS it then queries CloudTrail for management events over a stated 90-day
window, using each bucket's own region. It attributes changes for at most six
changed buckets per survey and shows at most 20 matching events. If the lookup
is denied, unsupported or fails, the actor remains unknown; it is never reported
as nobody. A truncated lookup says so. The result never claims that CloudTrail
has the complete history or that an unlisted change did not happen.

## Inventory and open questions

`query` exists for questions that do not fit one bucket or one object. The
script runs in a QuickJS sandbox with ten read-only primitives. The query's
step shows the returned rows (at most 500; the model sees at most 40) and the
script as evidence.

When a bucket has S3 Inventory, `inventory` reads the latest manifest and one
bounded page (default 100 rows, maximum 1,000) or imports every manifest file
with `full: true`. A page reads CSV up to 32 MiB or Parquet up to 16 MiB; a
larger file is reported, not silently cut. Full import is bounded to 1,000
files, 128 MiB per file, 512 MiB total and 2,000,000 rows. The result states the
manifest date and whether coverage is partial.

Code mode budgets are 2,000 calls, 500,000 listed items, 120 seconds and 256 MiB
per script. It never accepts arbitrary SQL, network, filesystem, process or
module access.

## Capacity

On AWS a survey reads CloudWatch daily storage metrics: size by storage class,
object count, 14-day growth and a storage-only list-price estimate at us-east-1
prices. The figure is an estimate, not a bill; requests, transfer, retrieval and
discounts are not included. S3-compatible endpoints publish no equivalent, so
the app measures with `query` instead and does not invent a number.

## Search

⌘K focuses the sidebar search. It covers task titles, the user's messages
(steers included) and the agent's text. A message or text hit opens its task and
scrolls to that message. Title search reads `task_meta`; the rest reads the
derived `search_docs` index. Search uses FTS5 trigram ranking, with a LIKE
fallback for short CJK queries, and returns at most 20 hits.

## Model fit

The provider reports the model list in Settings. The context window is inferred
(unknown models fall back to 128k), and reasoning is on at medium for known
reasoning models, off otherwise. Context below 64k is a small model, below 200k
mid, otherwise large. Small gets a 14-round budget, mid 24 and large 32. The
agent asks for one of the four method cards with `skill`; they are not injected
into every prompt. The answer format does not change.

## Settings

- **Model** — provider, model id, base URL and API key. Pasting a key fetches the
  provider's models automatically; the manual fetch remains only when no key is
  present. Save stores it; Test checks the values in the form, even before
  saving.
- **Accounts** — provider kind (auto or explicit), endpoint, region, keys or
  AWS profile, optional bucket scope and path-style addressing. The account
  list shows the masked key id or profile name.
- **Memory** — a note age filter and the notes the agent
  wrote. Notes can be forgotten here.
- **Appearance** — English/Chinese, system/light/dark, notification switch.
- **Version** — installed version and the update state; a missing feed says so
  instead of failing silently.

## Known limits

- Access evidence is partial by design; see above and `docs/security.md`.
- A survey is capped at 5,000 buckets and has a 300-second budget with a
  20-second reserve. An incomplete survey reports pending buckets.
- CloudTrail covers 90 days and is attributed for at most six changed buckets
  per survey; only management events are considered.
- A change plan covers the selected open risks (at most 500) and reports any
  residual rule that has no generated change. A merged lifecycle omits Terraform
  when existing rules contain fields the renderer cannot reproduce.
- A code-mode script is bounded to 6,000 characters and the budgets above.
- Notes are capped at 500; each note is at most 1,000 characters.
- Attachments are limited to ten files and 4 GiB each.
- There is no automatic background watch, dashboard, second window or import
  from an earlier app version.

## Issues from rules

Twelve deterministic rules produce Issues. A rule is decided only from a
reading that could see the required dimension; a blind read leaves it
undecided.

| Code | Severity | Control | Rule |
|---|---|---|---|
| `account_public_access_block_missing` | medium | S3.1 | Account-wide public access block not fully enabled (AWS) |
| `public_exposure` | high | S3.2 | Bucket is publicly accessible |
| `wildcard_principal` | medium | | Policy allows a wildcard principal |
| `insecure_transport` | medium | S3.5 | Policy does not deny plain HTTP (AWS) |
| `cors_all_origins` | medium | | CORS allows all origins |
| `no_default_encryption` | medium | | No default encryption |
| `public_access_block_missing` | medium | S3.8 | Public access block not fully enabled (names the switches that are off) |
| `acls_enabled` | low | S3.12 | ACLs still decide access (ownership not enforced) |
| `access_logging_off` | low | S3.9 | Server access logging is off |
| `no_abort_mpu` | medium | | Incomplete multipart uploads are never cleaned up |
| `noncurrent_never_expire` | medium | | Noncurrent versions never expire |
| `large_standard_only` | low | | At least 500 GiB and 90% Standard, with no transition and no lifecycle rule that moves it (AWS, CloudWatch) |

Exposure is proved by the provider's policy-status verdict when one exists, or
by evaluating the policy document locally. A public access block at the bucket
or account level can cancel exposure. A bucket is never called clean because a
read failed; an unread policy, ACL or configuration leaves the matching rule
undecided.

## Change plans

`change_plan` returns one deterministic change plan. It is the tool behind the
`Prepared a change plan` step in the conversation. Each step
carries AWS CLI, Terraform and API document text plus an impact preview from the
remembered posture. It can target one bucket and code, or every open risk (it
scans up to 500). Lifecycle changes for one bucket merge into one document; when
existing rules are present, the Terraform tab is omitted rather than rendering
an incomplete authoritative resource. A policy change is merged with the
current policy only when that policy was read and names no account id.
Otherwise the step is marked manual and keeps its blocker; the plan never
reproduces an unread or account-bearing policy in the window. The plan states
its baseline (the latest complete reading or remembered state), lists residual
risks it does not cover, and is text the user applies. The bucket name must
match `[A-Za-z0-9][A-Za-z0-9._-]{0,254}`; otherwise no safe change is generated.
The app never applies the text and there is no Apply button.

The plan never says a step was applied. To learn whether it was, the user asks
the agent after applying it; the agent re-reads the bucket, the rules decide
again, and the survey or config step shows what resolved. The plan-aware
re-check of 35.x was removed in 36.0.

## Memory and retention

The estate is remembered bucket posture with the date it was read, open and
accepted Issues with their evidence, notes, the latest change rows and a compact
`readings` history (trigger, coverage counts, open totals and whether the read
was complete). The prompt tells the agent to start from memory, to say when an
answer is memory, and to read before it concludes.

`estate` also answers temporal questions with `history: true`: Issue events
(opened, resolved, recurred, gone, accepted, reopened), posture changes and
reading events (`read`; older rows show `checked` or `rechecked`), newest
first. Issue events and
posture changes narrow by bucket, code or `since`; reading events are
account-wide, so a bucket or code filter omits them. The history table opens
under the `estate` step; it is evidence about what happened, not a new findings
list. The model sees the same structured rows
inside the untrusted-data envelope; raw requests and `search_docs` text are
never part of memory.

There is no automatic watch or background monitor. An account can opt into a
daily or weekly scheduled check, a message to the agent sent while the app is
open and a model is set. Deleting a task
purges its conversation, entries, documents, datasets, uploads, search rows,
audit rows and task directory. Issue event history remains with a null
conversation id. See [data-model.md](data-model.md) for the exact tables.
