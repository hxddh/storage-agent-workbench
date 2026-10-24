# Product

Storage Agent answers questions about object storage by reading it. It is not a
console, a dashboard, a ticket system or a chat product: it is a task list and a
brief.

## The three surfaces

1. **Task list** — every task, newest first, with a state dot. New task, rename,
   delete, Settings. Nothing else. The task open at quit opens at launch.
2. **Task** — one brief, not a transcript: a verdict, the findings the tools
   proved, one data section, the fix, the checks that produced them, and the
   questions that led here. The page scrolls; the composer stays.
3. **Settings** — model and thinking level, storage accounts (keys or AWS
   profile), memory, language, theme and notifications. A full-screen sheet,
   not a wizard. A downloaded update shows one line there.

The composer is docked at the foot of the window on every screen, including
Home. Home is an empty task: one heading, one hint when setup is missing.

## A task

- The user writes a request. It is recorded immediately; the run is durable.
- While it runs, a check appears the moment a tool starts and shows its real
  progress (`3 of 12 buckets`). The check row settles in place; the Checks
  section opens while work is happening and folds to a receipt when it ends.
- A partial verdict streams at the top of the page. Nothing waits for the end.
- **Add to the request** (Enter while running) steers the run. **Stop** (or ⌘.)
  keeps what was read and offers **Continue**, which resumes without a new
  question on the page.
- A failure becomes one notice with **Retry**, which asks the last request
  again with its files; no dialog. Notices are worded in the user's language.
- Long tasks survive a restart; pi resumes the interrupted work once.
- A run that finishes while the window is in the background sends one system
  notification (Settings can turn it off). The dock shows a badge, or the
  taskbar a progress bar, while anything runs.
- Every run uses the model and thinking level in Settings, including runs in
  tasks started with another model.

## The brief

The model writes one thing: the **verdict**, at most two sentences. Everything
else is projected deterministically from tool results, so the page cannot
contradict the tools.

- **Findings** — the current state, not the history. Results are folded in
  order: a survey replaces what the task knew about its account, a review
  replaces what it knew about the rules it read, and a reading that proves a
  rule clean removes its finding. Merged by rule and bucket, ordered by
  severity, capped at five with the rest behind a single disclosure. Each row
  names the rule, the severity, the bucket and the evidence detail; a finding
  from memory says when it was read. Clicking a row opens Checks at the call
  that proved it; **Accept risk** on hover folds it.
- **Fixed in this task** — findings the task saw open and then proved fixed,
  folded into one green line.
- **Accepted** — risks the user accepted, folded into one line, each with
  **Reopen**.
- **Not read** — buckets whose exposure stayed undecided, buckets a stopped
  survey did not reach, and review blind spots.
- **Data** — the latest tabular result: bucket posture, an object list, object
  facts, or an analysis table and chart. Up to ten rows, then `N more`. It is
  open by default when there are no findings, because then it is the answer; a
  findings page keeps it folded.
- **Fix** — the generated formats, the impact verdict and its reasons; the
  newest fix open, earlier ones folded. A fix disappears once the task proves
  its problem fixed. The code is text the user applies; there is no Apply
  button.
- **Checks** — every tool call, in order, with target, result note and
  duration, folded to a receipt with the run's time and tokens. This is the
  evidence chain, not a debug pane: views already on the page do not open again
  here, and calls the harness refused to repeat are not listed.
- **Questions** — the requests behind the page, folded into one line.

There are no suggestions, next steps, follow-up chips or chat bubbles.

## Honesty

If a read was denied or unsupported, the brief says the question is open and
shows how many buckets could not be read. It never turns silence into "no
problems found".

The verdict names buckets, keys and accounts in backticks. A name no tool in the
task returned gets one correction request before the answer settles; if it is
still there, the page marks it and says so.

## Search

⌘K focuses the sidebar search. It covers task titles, requests, findings and
the current verdict. A finding hit opens its task with that finding highlighted;
an answer hit opens the verdict. A derived `search_docs` table is rebuilt when a
task settles and backfilled at startup; the search itself is `LIKE`, which
handles Chinese substrings (FTS trigram needs three characters).

## Issues

Seven deterministic rules open Issues from survey posture and configuration
reviews:

| Code | Severity | Rule |
|---|---|---|
| `public_exposure` | high | Bucket is publicly accessible |
| `wildcard_principal` | medium | Policy allows a wildcard principal |
| `cors_all_origins` | medium | CORS allows all origins |
| `no_default_encryption` | medium | No default encryption |
| `public_access_block_missing` | medium | Public access block not fully enabled (names the switches that are off) |
| `no_abort_mpu` | medium | Incomplete multipart uploads are never cleaned up |
| `noncurrent_never_expire` | medium | Noncurrent versions never expire |

Every rule is decided from one reading of the bucket (`s3/facts.ts`), so a
survey and a review cannot disagree. A rule is decided only by a read that could
see it. An unreadable policy, ACL or configuration leaves the rule undecided; it
is never resolved by that silence.

Exposure is proved by the provider's policy-status verdict when it has one, and
otherwise by evaluating the policy document: an Allow to everyone that no
source-IP, VPC, organization, account or principal condition narrows. A bucket's
public access block cancels exposure (`RestrictPublicBuckets`,
`IgnorePublicAcls`); the account-level block is not read, and the detail says
so.

An Issue is `open`, `resolved` or `accepted`. The model does not open, close,
re-grade or accept one. The user may accept a risk; it stays accepted while
readings still observe it and resolves when one proves it gone. A bucket that a
complete listing no longer shows resolves its Issues as gone.

## Fixes

`fix` generates the AWS CLI command, a Terraform resource and the API document,
targeting the account's endpoint and region. The bucket name must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,254}`; anything else has no safe fix. The impact
preview uses the recorded posture and says what it cannot tell. Storage Agent
never applies a fix.

## Memory and retention

The estate is the agent's memory: bucket posture with the date it was read, open
and accepted Issues with their evidence, and notes. Notes are visible and
deletable in Settings. The prompt tells the agent to read memory first and
survey only when it is empty, stale or the question is about current exposure,
and to re-read only the bucket a user says they fixed.

There is no watch, no background check and no scheduled task. A task runs when
the user asks. Deleting a task permanently removes its conversation, entries,
documents, datasets, uploads, search rows and audit events.
