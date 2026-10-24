# Tools

Ten tools, all read-only, all registered in one pi extension
(`runtime/agent.ts`). Every call goes through `agentTool()`, which applies the
account scope, a timeout, an audit row, redaction and the untrusted-data
envelope, and attaches a typed `view` and a `status` (`done`, `failed`,
`refused`, `timeout`, `stopped`) for the window.

| Tool | Input | Model output | View |
|---|---|---|---|
| `survey` | `provider_id?`, `buckets?` (≤50), `limit?` (≤5000) | buckets read, public, account block, capacity and largest buckets, undecided rules, issue delta, what was not read | bucket table with capacity, open and accepted Issues (first 1,000 and the total), resolutions, account block, coverage |
| `buckets` | `provider_id?` | names | name + created |
| `objects` | `bucket`, `prefix?`, `kind?` (`keys`/`versions`/`uploads`), `limit?` (≤200) | count | key table |
| `object` | `bucket`, `key`, `aspects?` (`head`/`tags`/`acl`/`preview`) | facts | fact list, bounded text preview |
| `config` | `bucket`, `aspect?` (`security`/`lifecycle`/`observability`/`access`) | findings, blind spots, rules proved clean; for `access`, grants and their source | finding list, observations, access chain |
| `probe` | `provider_id?`, `bucket?`, `check?` (`reach`/`tls`/`latency`/`location`/`addressing`) | check outcomes | check list |
| `estate` | `provider_id?`, `bucket?`, `notes?` | remembered buckets with their age, Issues with evidence, notes | bucket table, Issues, notes |
| `fix` | `bucket?`, `code?` (omit for every open issue) | one set of CLI/notes/impact per issue class | CLI/Terraform/API tabs, impact, batch folds |
| `note` | `text`, `scope?`, `bucket?`, `provider_id?` | confirmation | note text |
| `query` | `title`, `code`, `provider_id?` | the first 40 rows, call and listing counts, script output | table, bar chart, the script, buckets read |

## Code mode (`query`)

The script runs in a QuickJS sandbox (`@earendil-works/pi-codemode`): no
`fetch`, `require`, `process`, timers or modules. Its only capabilities are nine
read-only primitives, all scoped to the account:

| Primitive | Reads |
|---|---|
| `buckets()` | ListBuckets, filtered by scope |
| `list({bucket, prefix?, delimiter?, kind?, token?, max?})` | one page of ListObjectsV2, ListObjectVersions or ListMultipartUploads |
| `head({bucket, key})` | HeadObject; metadata keys, never values |
| `config({bucket, aspect?})` | the same reading `config` uses, as statuses and proved rule codes |
| `capacity({bucket})` | CloudWatch storage metrics (AWS only) |
| `estate()` | remembered buckets and open Issues |
| `inventory({bucket})` | latest S3 Inventory manifest and bounded CSV/Parquet rows |
| `dataset({file, kind?})` / `aggregate({...})` | import an attached log/inventory and run a whitelisted aggregate |

Budget per script: 2,000 calls, 500,000 listed items, 120 seconds, 256 MiB.
The returned rows (at most 500 on the page, 40 to the model) are redacted; the
script and the buckets it read are kept in the view as evidence. `inventory`
reads at most a page of the latest manifest; Parquet up to 16 MiB and CSV up to
8 MiB are bounded, and a larger file is reported rather than loaded whole.

## Rules the tools enforce

- A bucket outside `provider.scope.buckets` is refused before any request.
- `survey` and `config` read through `s3/facts.ts` and decide rules from facts;
  a blind read decides nothing. `survey` remembers each bucket as soon as it is
  read, reads the longest-unread first, stops starting buckets 20 s before its
  300 s timeout, and reports the rest as not read; calling it again continues.
  Only a complete, unscoped listing marks a bucket gone.
- On AWS, `survey` reads the account-wide public access block (STS
  GetCallerIdentity, then S3 Control) and CloudWatch capacity, one
  GetMetricData call per region and 40 buckets. An S3-compatible endpoint has
  neither, and the rules that need them stay undecided.
- The harness blocks a storage read repeated with the same arguments in one run
  (`estate`, `fix`, `note` and `survey` may repeat) and every call after the model tier's
  round budget (14 small, 24 mid, 32 large).
- `object.preview` reads at most 8 KiB and only for text-like content types under
  1 MiB; the body of a large object is never downloaded.
- `dataset` imports at most 2,000,000 rows and `aggregate` answers only
  whitelisted metrics and dimensions; it never accepts SQL.
- `note` is capped at 1,000 characters and 500 notes; it is redacted and
  recorded as `author=agent`.
- `survey` opens and resolves Issues through `estate`, never through prose.
- `access` is evidence, not an authorization decision: a blind IAM/KMS/Analyzer
  read is shown; a provider that lacks a concept is not called missing.

## Not available

No write, delete, copy, move, ACL change, lifecycle put, policy put, bucket
creation, object download (beyond a bounded preview), shell, arbitrary SQL or
generic HTTP. An S3 API a provider does not implement is reported as
`provider_unsupported`; it is never simulated.
