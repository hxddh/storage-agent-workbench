# Tools

Twelve tools in one pi extension (`runtime/agent.ts`), grouped by capability
in this page as **read**, **query**, **memory**, **change_plan** and **ask**
(`tools/registry.ts` lists the names; each tool's description, sent with its
schema, is the only place the model learns what it does). Every tool except `ask` goes through `agentTool()`, which applies
account scope, a timeout, an audit row, redaction and the untrusted-data envelope, and attaches a typed `view`, a
`status` (`done`, `failed`, `refused`, `timeout`, `stopped`) and an
`evidenceId`.

`ask` is the one tool that does not read storage: it puts a question to the
user. 36.0 removed `plan` (a checklist the window drew) and `skill` (method
documents the agent loaded); the agent says its plan in its own words, and what
a method said now lives in the description of the tool it is about. `change_plan` generates text from remembered Issues; the app never
applies it. `accept_risk` asks the user to confirm accepting a risk; it changes
nothing itself.

| Group | Tool | Input | Model output | View |
|---|---|---|---|---|
| read | `survey` | `provider_id?`, `buckets?` (≤5000), `limit?` (≤5000) | buckets read, the bucket table, open Issues, public, account block, capacity and largest buckets, undecided rules, Issue delta, what was not read | bucket table with capacity, open and accepted Issues, resolutions, account block, coverage |
| read | `buckets` | `provider_id?` | name + created table | name + created |
| read | `objects` | `provider_id?`, `bucket`, `prefix?`, `kind?` (`keys`/`versions`/`uploads`), `limit?` (≤1000, S3's page; default 100), `token?` | the page as a table and a `next` token when more exist | key table with truncation |
| read | `object` | `provider_id?`, `bucket`, `key`, `aspects?` (`head`/`tags`/`acl`/`preview`) | facts (metadata names only, never values) and the text preview | fact list, bounded text preview |
| read | `config` | `provider_id?`, `bucket`, `aspect?` (`security`/`lifecycle`/`observability`/`access`) | findings, blind spots, rules not triggered, exposure, missing permissions, the bucket's Issues; for `access`, every grant, blind source, missing permission and coverage | finding list, observations, access chain and coverage |
| read | `probe` | `provider_id?`, `bucket?`, `check?` (`reach`/`tls`/`latency`/`location`/`addressing`) | check outcomes | check list |
| read | `query` | `provider_id?`, `title?`, `code` | every row on the page (up to 500), call/listing counts, script output | table, bar chart, script, buckets read |
| memory | `estate` | `provider_id?`, `bucket?`, `code?`, `history?`, `since?`, `notes?` | the remembered bucket table with age, every Issue (each line has `· rule <code>`), notes; with `history`, Issue events, posture changes and reading counts | bucket table, Issues, notes, optional history table |
| memory | `note` | `text`, `scope?` (`estate`/`provider`/`bucket`), `bucket?`, `provider_id?` | confirmation | note text |
| memory | `accept_risk` | `provider_id?`, `bucket` (empty for the account rule), `code` (the rule code as `estate` lists it), `accept?` (default true; false reopens) | the window asks the user; it is not accepted until they confirm | confirmation card with **Accept risk** or **Reopen** |
| change_plan | `change_plan` | `provider_id?`, `bucket?`, `code?` (omit for every open Issue; both plan that change for that bucket, Issue or not) | one change plan: baseline (latest account survey, as counts), merged steps, manual blockers, residual, impact (scans up to 500) | plan rows; each step opens CLI/Terraform/API tabs and impact |
| ask | `ask` | `question`, `options?`, `note?` | the question; the turn ends until the user answers | the question as an agent message, with a button per option, if any, while it waits |

## Answer and citations

The agent's text is the answer. It is normal Markdown; there is no answer tool
and no report block protocol, and a turn may hold several texts between tool
calls. The model may link a tool result by the actual evidence id from the
`<untrusted-data evidence="…">` tag, for example `[1](#ev-call_survey_1)`. In
the window the link is a small button; clicking it opens that call's step in
place and scrolls to it. The app does not validate citations or names; a link
that matches no call is shown greyed as plain text, with a tooltip saying so.

Every call is a step in the conversation, where it happened, a call the round
budget blocked included: a state mark, the tool's label, target, note, a status
word when it did not finish, and its duration. An open step shows the shaped
result and, under `What the agent received`, the exact text the model got. A
tool's model text carries the data its view shows, so the view never shows the
user something the agent did not receive. A running step is open and shows `Waiting for the first result.`
until it settles; a settled step opens on click to show the argument summary
and the typed result. Live progress comes from `ToolDetails.progress` and the
live tool's note, redacted and bounded; raw tool output never reaches the
window. Failed, refused, stopped and timed-out calls stay in place.

The 35.x Work ledger, Sources drawer, Findings and Not checked strips and
citation validation were removed in 36.0.

## Code mode (`query`)

The script runs in a QuickJS sandbox (`@earendil-works/pi-codemode`): no
`fetch`, `require`, `process`, timers or modules, and model access stays off.
Its only capabilities are the scoped read-only primitives, all under the
account:

| Primitive | Reads |
|---|---|
| `buckets()` | ListBuckets, filtered by scope |
| `list({bucket, prefix?, delimiter?, kind?, token?, max?})` | one page of ListObjectsV2, ListObjectVersions or ListMultipartUploads; max 1,000 |
| `head({bucket, key})` | HeadObject; metadata keys, never values |
| `config({bucket, aspect?})` | the same security/lifecycle/observability reading `config` uses, as statuses and proved rule codes; not access |
| `capacity({bucket})` | CloudWatch storage metrics (AWS only) |
| `estate()` | remembered buckets and open Issues |
| `principal({bucket?, principal?, limit?})` | grant evidence for one bucket, or remembered buckets a principal reaches, with coverage |
| `inventory({bucket, maxRows?, full?})` | latest S3 Inventory manifest and one bounded page; `full` imports every manifest file into a dataset |
| `dataset({file, kind?})` | import one attached access log or inventory into a local SQLite dataset |
| `aggregate({file, metric, groupBy?, filters?, limit?})` | whitelisted aggregate over an imported dataset |

Budget per script: 2,000 calls, 500,000 listed items, 120 seconds and 256 MiB;
the script's length is not limited. The returned rows (at most 500 on the page,
all of them sent to the model) are redacted; the script and buckets it read stay in the view as evidence.

`inventory` without `full` reads one page of the latest manifest (default 100
rows, max 1,000). A CSV page up to 32 MiB or a Parquet page up to 16 MiB is
accepted; a larger file is reported instead of silently cut. With `full: true`,
every manifest file is imported into a local dataset, bounded to 1,000 files,
128 MiB per file, 512 MiB total and 2,000,000 rows. `aggregate` is the only way
to query that dataset.

## Accepting a risk

`accept_risk` names one open or accepted Issue by account, bucket and rule code.
It fails when no such risk is open or accepted. It returns an `accept` view and
tells the model the risk is not accepted until the user confirms. The window
shows a confirmation card (`Accept the risk “…” on …?`) with **Accept risk**, or
**Reopen** for `accept: false`; only that click calls `AppDb.setAccepted`. After
the click the card says `Accepted.` or `Reopened.`; if a later reading proved
the risk fixed, it says so instead of offering the button.

## Rules the tools enforce

- A bucket outside `provider.scope.buckets` is refused before any request.
- `survey` and `config` read through `s3/facts.ts` and decide rules from facts;
  a blind read decides nothing. They never write an Issue: they hand the
  decisions to the call's `Assessor` (`estate/assess.ts`). `survey` remembers each bucket as soon as it is
  read, reads the longest-unread first, uses at most 12 concurrent readers, stops
  starting buckets 20 seconds before its 300-second timeout, and reports the
  rest as pending; calling it again continues. Its step note gives the buckets
  read and, when the read changed Issues, `n new issues` and `n resolved`.
- Only a complete, unscoped, untruncated listing marks a bucket gone. A scoped
  or partial survey never does.
- On AWS, `survey` reads the account-wide public access block (STS
  GetCallerIdentity, then S3 Control) and CloudWatch capacity. Capacity queries
  are batched in GetMetricData calls; the storage estimate is a list-price
  estimate, not a bill. An S3-compatible endpoint has neither, and the rules
  that need them stay undecided.
- The harness blocks a call only past a runaway ceiling of **100** rounds of
  tool calls in one turn. There are no per-model budgets, and it never refuses
  a repeated call; how much to read is the agent's decision.
- `object.preview` reads at most 8 KiB and only for text-like content types under
  1 MiB; the body of a large object is never downloaded.
- `dataset` imports at most 2,000,000 rows and `aggregate` answers only
  whitelisted metrics and dimensions; it never accepts SQL.
- `note` is redacted and recorded as `author=agent`; its length and the number
  of notes are not capped.
- `survey` opens and resolves Issues through `estate`, never through prose.
- `estate(history: true)` reads at most 80 Issue events and 200 posture
  changes, merges and orders them newest first, and keeps at most 60 rows in
  the view. An unfiltered history also includes at most 30 reading records.
  Reading rows are account-wide, so a `bucket` or `code` filter omits them.
  `since` is an ISO date or timestamp. History is memory evidence, never raw
  request text, and it does not make the current reading fresh.
- `change_plan` returns one plan. Lifecycle rules are merged per bucket and a current
  lifecycle or policy that cannot be read becomes a manual step with a blocker.
  A current policy containing an account id is never reproduced in the window;
  the step carries only a new statement. A merged lifecycle with existing rules
  omits Terraform rather than rendering an incomplete authoritative resource.
  The plan lists residual findings it cannot cover. No change is applied by a
  tool.
- `access` is evidence, not an authorization decision: policy and ACL rows are
  grants; identity grants are intersected with bucket-policy Denies and, when
  read, SCPs and boundaries; action/resource forms are paired and ARNs are
  matched case-sensitively. IAM is read with
  `GetAccountAuthorizationDetails` and evaluated locally; SCPs are read through
  Organizations when available; conditions, unread policies and truncation are
  shown in the coverage line. A provider that lacks a concept is not called
  missing.
- `survey` reads at most 5,000 buckets per call. `config` access display is
  capped at 120 paths. Access coverage has its own IAM/SCP/Analyzer bounds.
- A folder or prefix listing is a page, not an exhaustive listing; the view and
  the model text say when a result is truncated.

## Not available

No write, delete, copy, move, ACL change, lifecycle put, policy put, bucket
creation, full object download (beyond a bounded preview), shell, arbitrary SQL
or generic HTTP. An S3 API a provider does not implement is reported as
`provider_unsupported`; it is never simulated. Dataset import is limited to
attached task files, not arbitrary filesystem paths.
