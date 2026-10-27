# Tools

Twelve tools in one pi extension (`runtime/agent.ts`), grouped by capability:
**read**, **query**, **memory**, **change_plan**, **plan** and **skill**. Read
tools go through `agentTool()`, which applies account scope, a timeout, an audit
row, redaction and the untrusted-data envelope, and attaches a typed `view`, a
`status` (`done`, `failed`, `refused`, `timeout`, `stopped`) and an `evidenceId`.

`plan` and `skill` are control tools. They shape the run and never read storage.
`change_plan` generates text from remembered Issues; the app never applies it.

| Group | Tool | Input | Model output | View |
|---|---|---|---|---|
| read | `survey` | `provider_id?`, `buckets?` (≤50), `limit?` (≤5000) | buckets read, public, account block, capacity and largest buckets, undecided rules, Issue delta, what was not read | bucket table with capacity, open and accepted Issues, resolutions, account block, coverage |
| read | `buckets` | `provider_id?` | names | name + created |
| read | `objects` | `provider_id?`, `bucket`, `prefix?`, `kind?` (`keys`/`versions`/`uploads`), `limit?` (≤200; default 50) | one page count | key table with truncation |
| read | `object` | `provider_id?`, `bucket`, `key`, `aspects?` (`head`/`tags`/`acl`/`preview`) | facts | fact list, bounded text preview |
| read | `config` | `provider_id?`, `bucket`, `aspect?` (`security`/`lifecycle`/`observability`/`access`) | findings, blind spots, rules proved clean; for `access`, grants and coverage | finding list, observations, access chain and coverage |
| read | `probe` | `provider_id?`, `bucket?`, `check?` (`reach`/`tls`/`latency`/`location`/`addressing`) | check outcomes | check list |
| read | `query` | `provider_id?`, `title`, `code` (≤6,000 chars) | first 40 rows, call/listing counts, script output | table, bar chart, script, buckets read |
| memory | `estate` | `provider_id?`, `bucket?`, `code?`, `history?`, `since?`, `notes?` | remembered buckets with age, Issues, notes; with `history`, Issue events, posture changes and reading events | bucket table, Issues, notes, optional history table |
| memory | `note` | `text` (≤1,000 chars), `scope?` (`estate`/`provider`/`bucket`), `bucket?`, `provider_id?` | confirmation | note text |
| change_plan | `change_plan` | `provider_id?`, `bucket?`, `code?` (omit for every open Issue) | one change plan: baseline, merged steps, manual blockers, residual, impact (scans up to 500) | plan rows; each step opens CLI/Terraform/API tabs and impact |
| plan | `plan` | `steps` (1–6), `note?` | optional plan recorded | pending/active/done/blocked steps |
| skill | `skill` | `name?` | one method, or the four methods | not a check; shown under Methods |

## Answer and sources

The final assistant message is the answer. It is normal Markdown; there is no
answer tool and no report block protocol. The model cites a tool result by the
actual evidence id from the `<untrusted-data evidence="…">` tag, for example
`[1](#ev-call_survey_1)`. The window resolves that id to the tool view, validates
every citation, leaves an unresolved one as plain text and shows a quiet note.
The model never writes a table of facts.

The window shows one proof: the first cited tool result, otherwise the latest
data read, otherwise the latest change plan. When there is no proof, the current
risk list stands in its place. `Sources` is one compact index below the answer.
Risks, Data, Change plan, Tool calls, Not checked, Checked again, Changes and
Methods appear only when they have content; one row opens one section. There is
no legacy report block path.

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

Budget per script: 2,000 calls, 500,000 listed items, 120 seconds, 256 MiB and
6,000 characters of code. The returned rows (at most 500 on the page, 40 to the
model) are redacted; the script and buckets it read stay in the view as evidence.

`inventory` without `full` reads one page of the latest manifest (default 100
rows, max 1,000). A CSV page up to 32 MiB or a Parquet page up to 16 MiB is
accepted; a larger file is reported instead of silently cut. With `full: true`,
every manifest file is imported into a local dataset, bounded to 1,000 files,
128 MiB per file, 512 MiB total and 2,000,000 rows. `aggregate` is the only way
to query that dataset.

## Skills

Four on-demand methods: `access`, `change`, `inventory`, `capacity`. Skills are
documentation for the model, not storage evidence and not checks. A method the
agent loads appears under **Methods** in Sources; it does not consume a Tool
calls row.

## Plan

`plan` is optional. Use it when the work has several distinct steps; omit it for
a short read. It renders 1–6 steps with pending/active/done/blocked states and
folds away when a normal answer settles. A stopped run keeps it and offers
Continue.

## Rules the tools enforce

- A bucket outside `provider.scope.buckets` is refused before any request.
- `survey` and `config` read through `s3/facts.ts` and decide rules from facts;
  a blind read decides nothing. `survey` remembers each bucket as soon as it is
  read, reads the longest-unread first, uses at most 12 concurrent readers, stops
  starting buckets 20 seconds before its 300-second timeout, and reports the
  rest as pending; calling it again continues.
- Only a complete, unscoped, untruncated listing marks a bucket gone. A scoped
  or partial survey never does.
- On AWS, `survey` reads the account-wide public access block (STS
  GetCallerIdentity, then S3 Control) and CloudWatch capacity. Capacity queries
  are batched in GetMetricData calls; the storage estimate is a list-price
  estimate, not a bill. An S3-compatible endpoint has neither, and the rules
  that need them stay undecided.
- The harness blocks a storage read repeated with the same arguments in one run
  (`estate`, `change_plan`, `note` and `survey` may repeat) and every call after
  the model tier's round budget (**14 small, 24 mid, 32 large**).
- `object.preview` reads at most 8 KiB and only for text-like content types under
  1 MiB; the body of a large object is never downloaded.
- `dataset` imports at most 2,000,000 rows and `aggregate` answers only
  whitelisted metrics and dimensions; it never accepts SQL.
- `note` is capped at 1,000 characters and 500 notes; it is redacted and
  recorded as `author=agent`.
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
