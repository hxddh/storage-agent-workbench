# Product

Storage Agent is a local, read-only agent for object storage. It answers by
reading an account, remembers what it read, and projects the result as a run:
the agent's plan, the answer it composed, and the evidence behind it. It is not
a console, a dashboard, a ticket system or a chat product.

## The surfaces

1. **Task list** — new task, search, pinned/today/earlier groups, task state and
   relative time, rename, pin, delete and Settings. A new task starts empty; a
   deterministic account check also appears here. The task open at quit opens at
   launch.
2. **Task** — one run, not a transcript. The page scrolls; the composer stays.
3. **Settings** — a full-screen sheet with a labeled **Done** control, for the
   model, storage accounts, memory, language, theme and notifications. It is one
   sheet, not a wizard.

The composer is docked at the foot of the window on Home and in a task. It sends
a model request, a steer while a run is active, or a follow-up in the same task.
Without a model it is disabled for free-form questions; a model-free account
check still works.

## Home

Home is a quiet estate ledger, not a dashboard:

- one row per account with remembered bucket count, the last complete reading
  (or `no complete reading`) and open high/total risk;
- a line for new findings since the latest complete reading;
- **Check account**;
- recent runs, five at most, as quiet one-line links;
- the composer in its usual place.

With no account, the explicit choices are **Try with demo storage** and a setup
action: **Set up a model** before a model exists, or **Add an account** once one
does. With an account but no model, Home still offers **Check account** while
**Set up a model** remains available. Demo storage is in-process and never added
silently. Local models already running in Ollama or LM Studio can be chosen from
Home or Settings.

## Starting a check

**Check account** is deterministic and never calls a model:

1. It creates a task immediately with a title such as
   `Check · Demo · 2026-10-25 05:45`.
2. It surveys every configured account and emits transient survey progress.
3. It reads access evidence for up to 24 buckets per account, preferring open
   Issue buckets. When that is fewer than the account has, it reports
   `examined / total`.
4. It writes one durable `sa.audit` entry. The final checks and the deterministic
   summary are synthesized into the ordinary run surface; the page carries a
   `Deterministic account check` tag.

The progress line is live; the final checks are written when the reading ends.
A check is a snapshot, not a background monitor. **Check again** in a run
starts another check task; it does not mutate the old one. A settled reading
also records one `readings` row per account with its coverage and current open
risk. It stores no request, answer text, policy or secret.

## A model task

- The request is recorded immediately; the run is durable.
- While it runs, a check appears when a tool starts and shows its real progress
  (`3 of 12 buckets`). The check settles in place. The Checks section opens
  while work is happening and folds to a receipt when it ends.
- The agent publishes a short plan before its first read; it updates as the
  work changes. The plan is visible while the run is in flight and folds away
  when a normal answer settles. It stays for a stopped run or a blocked step.
- While it works, a draft answer and the current plan are visible; the finished
  report replaces the draft.
- When the evidence is ready, the agent calls `report` with ordered blocks. A
  summary or markdown block answers; table, timeline, plan and code blocks cite
  the tool result that proved them; findings selects deterministic findings.
  Summary prose can cite evidence as `[1](#ev-1)` and open the matching check.
- **Enter** while running steers the current run. **Stop** (or ⌘.) keeps what was
  read and offers **Continue** without adding a new question.
- A failed model run becomes one notice with **Retry**; it asks the last request
  again with its files. A stopped run offers **Continue**. A failed model-free
  check surfaces its error on the page; starting the check again creates a new
  task.
- Long tasks survive a restart; pi resumes interrupted work.
- A run that finishes while the window is in the background sends one system
  notification (Settings can turn it off). The dock badge or taskbar progress
  shows work in flight.
- Every model run uses the model in Settings, including old tasks; reasoning
  level and context window are inferred from that model. A model-free check uses
  neither.

There is no chat transcript. Earlier requests remain in the durable task and
appear under **Earlier in this task**: one compact row per turn, expandable to
its question, summary and check count. The latest turn stays expanded in the run
header. A deterministic account check has no question; its page starts with the
scope line and the verdict, not a task title posing as a request.

## The run

The page is composed for the question, not for every fact the task has read.
Top to bottom:

1. **Run header** — the latest question (never the task title posing as one),
   account name(s), a deterministic `Reads complete` or
   `Reads open: n · m blocked` status, `checked / total` buckets and the last
   read time. Copy and one overflow menu sit here. Severity counts appear on an
   account check, or when the answer carries a findings block. A failed
   or stopped storage read keeps the status open. A narrowed re-read never turns
   an account-wide gap into a complete reading.
2. **Notices** — stopped, failed, no-answer, model-missing and budget notices,
   with Retry or Continue where they apply. They sit outside the evidence fold.
3. **Plan** — the agent's own 3–6 steps, with pending, active, done and blocked
   states. It is process, not answer: it is visible while the run is live,
   remains for a stopped run or a blocked step, and is absent on a deterministic
   check. A settled answer does not carry the finished checklist.
4. **Answer** — the ordered blocks the agent composed: summary, markdown,
   callout, table, findings, timeline, plan or code. A summary, markdown or
   callout carries prose and evidence ids. A data block resolves one id to the tool view that proved it;
   the window drops a block whose evidence is missing and says how many. A
   summary is not limited to two sentences; it must stay grounded and concise.
   The window does not append a generic report after the answer.
5. **Additional evidence** — when the agent's report is prose only, the latest
   data read is shown as one preview: a survey, a query table and chart, an
   access chain, or a remembered history. Up to three or five rows; the table
   keeps its copy/save actions, and the Evidence control below opens the full
   check. When the agent already composed a table, timeline, findings or plan,
   that block is the answer and is not repeated here.
6. **Evidence** — one control on a settled task, labelled with its check count.
   It opens outside the answer, not interleaved with it. A report's findings
   block is already visible in the answer, so the evidence body does not
   duplicate current findings; accepted and fixed folds remain available. A
   report's plan block is the change plan and stays in the answer — the window
   does not assign the task a type to decide that. A deterministic check
   synthesizes a report with its findings and uses the same evidence fold for
   checks. The full evidence body still carries findings, re-verification,
   changed posture, **Not read** and checks when they exist.
7. **Checks** — every executed tool call in order, with target, result note and
   duration, folded to checks · time · tokens. Plan, report and playbook calls
   are control tools, not checks. They live with the rest of Evidence on every
   task, including a deterministic check.

A report's own table, timeline, plan or findings block is part of the answer and
is not folded. The deterministic sections underneath are evidence, not a second
answer.

Copy and a single overflow menu are always visible in the run header. The
overflow contains save Markdown, check again, re-verify, copy task link, export
evidence and save PDF. Evidence and PDF include the current findings, controls,
read timestamps and redacted views; there is no secret or unredacted provider
document in them.

### Findings and Issues

Findings are current state, not history. Results fold in order: a survey
replaces what the task knew about its account, a review replaces what it knew
about the rules it read, and a reading that proves a rule clean removes its
finding. The estate's current acceptance status is laid over the result. A
finding from memory says when it was read and is marked possibly stale after the
Settings threshold.

Findings are merged by rule and bucket, ordered by severity, and grouped by
bucket. Five are shown; the rest open with one **N more** control. Each finding
names its rule, severity, bucket and evidence. Clicking it opens the check that
proved it. **Accept risk** appears on hover or keyboard focus. Accepted risks are
folded, with **Reopen**. A finding the task saw open and then proved fixed goes
into one green one-line fold. If the survey view carries fewer Issues than the
account has, the page says how many.

An Issue is `open`, `resolved` or `accepted`. Rules open and close it; the model
never does. Accepting is the user's decision and survives later readings while
the risk is still observed. A bucket that a complete listing no longer shows
gets `gone_at`; its Issues resolve as `gone`.

### Open questions

**Not read** is not a warning decoration. It is the list of questions the task
cannot answer:

- buckets whose exposure or a required configuration read was blind;
- buckets a stopped or timed-out survey did not reach;
- buckets outside a capped survey;
- rules that stayed undecided because a dimension could not be read;
- permissions the reading needed but did not have;
- configured buckets that disappeared from a complete listing.

If there are no findings and this list is empty, the page says no problem was
found. If either has content, it does not.

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

This is **grant evidence**, not one complete authorization verdict. Policy and
ACL rows are not merged with every identity, SCP and condition into a single
yes/no. Conditions are shown but not evaluated; service principals, federated
identities and some external policies are not enumerated. The page shows
principal coverage (`evaluated / total`), undecided conditions and truncation.
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
as nobody. A truncated lookup says so. The run never claims that CloudTrail
has the complete history or that an unlisted change did not happen.

## Inventory and open questions

`query` exists for questions that do not fit one bucket or one object. The
script runs in a QuickJS sandbox with ten read-only primitives. The page shows
the returned rows (at most 500; the model sees at most 40) and the script as
evidence.

When a bucket has S3 Inventory, `inventory` reads the latest manifest and one
bounded page (default 100 rows, maximum 1,000) or imports every manifest file
with `full: true`. A page reads CSV up to 32 MiB or Parquet up to 16 MiB; a
larger file is reported, not silently cut. Full import is bounded to 1,000
files, 128 MiB per file, 512 MiB total and 2,000,000 rows. The page states the
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

⌘K focuses the sidebar search. It covers task titles, requests, findings and the
report summary. A finding hit opens its task with the finding highlighted; a
summary hit opens the run and scrolls to the answer. Title search reads `task_meta`; the rest reads the
derived `search_docs` index. Search is `LIKE`, not full-text search, and returns
at most 20 hits.

## Model fit

The provider reports the model list in Settings. The context window is inferred
(unknown models fall back to 128k), and reasoning is on at medium for known
reasoning models, off otherwise. Context below 64k is a small model, below 200k
mid, otherwise large. Small gets shorter method cards and a 14-round budget;
mid gets 24 and large 32. The answer format does not change.

## Settings

- **Model** — provider, model id, base URL and API key. Pasting a key fetches the
  provider's models automatically; the manual fetch remains only when no key is
  present. Save stores it; Test checks the values in the form, even before
  saving.
- **Accounts** — provider kind (auto or explicit), endpoint, region, keys or
  AWS profile, optional bucket scope and path-style addressing. The account
  list shows the masked key id or profile name.
- **Memory** — the stale threshold and the notes the agent wrote. Notes can be
  forgotten here.
- **Appearance** — English/Chinese, system/light/dark, notification switch.
- **Version** — installed version and the update state; a missing feed says so
  instead of failing silently.

## Known limits

- Access evidence is partial by design; see above and `docs/security.md`.
- A survey is capped at 5,000 buckets and has a 300-second budget with a
  20-second reserve. An incomplete survey reports pending buckets.
- The model-free check examines access paths for at most 24 buckets per account.
- CloudTrail covers 90 days and is attributed for at most six changed buckets
  per survey; only management events are considered.
- Re-verification replays at most 50 buckets per account, has a 120-second
  budget, and reports skipped or truncated buckets. A plan generates at most 20
  steps and scans at most 500 open Issues. A merged lifecycle omits Terraform
  when existing rules contain fields the renderer cannot reproduce.
- A code-mode script is bounded to 6,000 characters and the budgets above.
- Notes are capped at 500; each note is at most 1,000 characters.
- Attachments are limited to ten files and 4 GiB each.
- There is no background watch, scheduler, dashboard, chat transcript, second
  window or import from an earlier app version.

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

## Fixes

`fix` returns one deterministic change plan. Each step carries AWS CLI,
Terraform and API document text plus an impact preview from the remembered
posture. It can target one bucket and code, or every open Issue (it scans up to
500 and generates up to 20). Lifecycle fixes for one bucket merge into one
document; when existing rules are present, the Terraform tab is omitted rather
than rendering an incomplete authoritative resource. A policy fix is merged
with the current policy only when that policy was read and names no account id.
Otherwise the step is marked manual
and keeps its blocker; the plan never reproduces an unread or account-bearing
policy in the window. The plan states its baseline (the latest
complete reading or remembered state), lists residual findings it does not
cover, and is text the user applies. The bucket name must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,254}`; otherwise no safe fix is generated. The
app never applies the text.

**Re-verify** is the only path that confirms a plan step. It re-reads the plan's
buckets and the account-wide block, applies the same rules, and reports
`confirmed` only when every code in the step is now clear. An open or accepted
Issue is `not applied`; an unchecked bucket or undecided rule is `still unknown`.

## Memory and retention

The estate is remembered bucket posture with the date it was read, open and
accepted Issues with their evidence, notes, the latest change rows and a compact
`readings` history (trigger, coverage counts, open totals and whether the read
was complete). The agent reads memory first and surveys only when memory is
empty, stale or the question is about current exposure. It re-reads only the
bucket the user says they fixed.

`estate` also answers temporal questions with `history: true`: Issue events
(opened, resolved, recurred, gone, accepted, reopened), posture changes and
reading events (read, checked, rechecked), newest first. Issue events and
posture changes narrow by bucket, code or `since`; reading events are
account-wide, so a bucket or code filter omits them. The page renders
that history under the existing Data section; it is evidence about what
happened, not a new findings list. The model sees the same structured rows
inside the untrusted-data envelope; raw requests and `search_docs` text are
never part of memory.

There is no watch, no background check and no scheduled task. Deleting a task
purges its conversation, entries, documents, datasets, uploads, search rows,
audit rows and task directory. Issue event history remains with a null
conversation id. See [data-model.md](data-model.md) for the exact tables.
