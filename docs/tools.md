# Tools

Ten tools, all read-only, all registered in one pi extension
(`runtime/agent.ts`). Every call goes through `agentTool()`, which applies the
account scope, a timeout, an audit row, redaction and the untrusted-data
envelope, and attaches a typed `view` and a `status` (`done`, `failed`,
`refused`, `timeout`, `stopped`) for the window.

| Tool | Input | Model output | View |
|---|---|---|---|
| `survey` | `provider_id?`, `buckets?` (≤50), `limit?` (≤5000) | buckets read, public, account block, capacity and largest buckets, undecided rules, Issue delta, what was not read | bucket table with capacity, open and accepted Issues (first 1,000 and the total), resolutions, account block, coverage |
| `buckets` | `provider_id?` | names | name + created |
| `objects` | `provider_id?`, `bucket`, `prefix?`, `kind?` (`keys`/`versions`/`uploads`), `limit?` (≤200; default 50) | one page count | key table with truncation |
| `object` | `provider_id?`, `bucket`, `key`, `aspects?` (`head`/`tags`/`acl`/`preview`) | facts | fact list, bounded text preview |
| `config` | `provider_id?`, `bucket`, `aspect?` (`security`/`lifecycle`/`observability`/`access`) | findings, blind spots, rules proved clean; for `access`, grants and coverage | finding list, observations, access chain and coverage |
| `probe` | `provider_id?`, `bucket?`, `check?` (`reach`/`tls`/`latency`/`location`/`addressing`) | check outcomes | check list |
| `estate` | `provider_id?`, `bucket?`, `code?`, `history?`, `since?`, `notes?` | remembered buckets with their age, Issues with evidence, notes; with `history`, Issue events and posture changes | bucket table, Issues, notes, optional history table |
| `fix` | `provider_id?`, `bucket?`, `code?` (omit for every open issue) | one set of CLI/notes/impact per issue (scans up to 500, emits up to 20) | CLI/Terraform/API tabs, impact, batch folds |
| `note` | `text` (≤1,000 chars), `scope?` (`estate`/`provider`/`bucket`), `bucket?`, `provider_id?` | confirmation | note text |
| `query` | `provider_id?`, `title`, `code` (≤6,000 chars) | first 40 rows, call and listing counts, script output | table, bar chart, script, buckets read |

## Code mode (`query`)

The script runs in a QuickJS sandbox (`@earendil-works/pi-codemode`): no
`fetch`, `require`, `process`, timers or modules, and model access stays off.
Its only capabilities are ten read-only primitives, all scoped to the account:

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
  (`estate`, `fix`, `note` and `survey` may repeat) and every call after the
  model tier's round budget (**14 small, 24 mid, 32 large**).
- `object.preview` reads at most 8 KiB and only for text-like content types under
  1 MiB; the body of a large object is never downloaded.
- `dataset` imports at most 2,000,000 rows and `aggregate` answers only
  whitelisted metrics and dimensions; it never accepts SQL.
- `note` is capped at 1,000 characters and 500 notes; it is redacted and
  recorded as `author=agent`.
- `survey` opens and resolves Issues through `estate`, never through prose.
- `estate(history: true)` reads at most 80 Issue events and 200 posture
  changes, merges and orders them newest first, and keeps at most 60 rows in
  the view. `since` is an ISO date or timestamp. History is memory evidence,
  never raw request text, and it does not make the current reading fresh.
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
