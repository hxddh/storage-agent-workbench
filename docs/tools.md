# Tools

Nine tools in one pi extension (`runtime/agent.ts`): seven reads (`buckets`,
`objects`, `object`, `config`, `account`, `probe`, `query`), memory (`note`)
and `ask`. `tools/registry.ts` lists the names; each tool's description, sent
with its schema, is the only place the model learns what it does. Every tool
except `ask` goes through `agentTool()` (`tools/policy.ts`), which applies a
timeout, an audit row, redaction, `bound()` and the untrusted-data envelope,
and attaches a typed `view`, a `status` (`done`, `failed`, `refused`,
`timeout`, `stopped`) and an `evidenceId`. Each bucket-scoped tool calls
`assertInScope()` before its first request.

Tools return data, not judgements. There is no rule engine, no Issue, no
exposure verdict and no change-plan generator: the agent reads, decides what
the data means and writes any change as its own text. 36.0 removed `survey`,
`estate`, `change_plan` and `accept_risk`; calls to them in older tasks still
show as steps with what the agent received.

| Tool | Input | Model output | View |
|---|---|---|---|
| `buckets` | `provider_id?` | bucket and created table, filtered to scope | `buckets` table |
| `objects` | `provider_id?`, `bucket`, `prefix?`, `kind?` (`keys`/`versions`/`uploads`), `limit?` (≤1000, S3's page; default 100), `token?` | the page as a table and a `next` token when more exist | `objects` table with truncation |
| `object` | `provider_id?`, `bucket`, `key`, `aspects?` (`head`/`tags`/`acl`/`preview`; default `head`) | facts (metadata names only, never values) and the text preview | `object` facts, bounded text preview |
| `config` | `provider_id?`, `bucket`, `sections?` (omit for all) | the bucket's region and each section as JSON | `raw`: sections with status and JSON |
| `account` | `provider_id?`, `read`, `bucket?`, `key?`, `days?`, `token?`, `region?` | the read as JSON, `{ status, value }` or `{ status, error }` | `raw` |
| `probe` | `provider_id?`, `bucket?`, `check?` (`reach`/`tls`/`latency`/`location`/`addressing`; omit for the first three) | one `ok`/`fail` line per check | `probe` check list |
| `query` | `provider_id?`, `title?`, `code` | every row on the page (up to 500), call and listing counts, script output | `query`: table, bar chart, script, buckets read |
| `note` | `text`, `scope?` (`estate`/`provider`/`bucket`), `bucket?`, `provider_id?` | `Remembered (<scope>): <text>` | `note` |
| `ask` | `question`, `options?` (≤6), `note?` | the question; the turn ends until the user answers | `question`: the question as an agent message, with a button per option |

Timeouts: `buckets` 30 s; `objects`, `object` and `probe` 60 s; `config` 90 s;
`account` 120 s; `query` its 120-second budget plus 15 s; `note` 10 s.

## `config` sections

`config` reads `GetBucketLocation` first and, when the bucket lives in another
region, sends the rest through a client for that region. Sections
(`SECTIONS` in `s3/raw.ts`): `location`, `policy` (parsed JSON),
`policy_status`, `public_access_block`, `acl`, `ownership`, `encryption`,
`versioning`, `object_lock`, `lifecycle`, `replication`, `cors`, `website`,
`logging`, `notification`, `inventory`, `tagging`. Each is `{ status, value }`
or `{ status, error }`, where status is `available`, `not_configured`,
`access_denied`, `provider_unsupported`, `missing`, `region_mismatch` or
`error`, and the error is the provider's code and message. A "no such
configuration" answer is `not_configured` with no error. The step note counts
sections by status.

## `account` reads

AWS only; any other provider kind returns `provider_unsupported`. Reads
(`ACCOUNT_READS`): `public_access_block` (account-wide S3 block),
`iam` (one page of `GetAccountAuthorizationDetails`, 100 items; the returned
`Marker` is the next `token`), `scps` (the SCPs attached to the account, its OUs
and the root, with their documents), `kms_key_policy` (`DescribeKey` and the
`default` key policy, by `key`), `access_analyzer` (one page of findings per
analyzer, for `bucket` when given), `storage_metrics` (CloudWatch daily
`BucketSizeBytes` by storage type and `NumberOfObjects` for `bucket`, default 14
days), `cloudtrail` (one page of 50 management events naming `bucket`, default
90 days; `token` for the next). The region is the one named, a key ARN's own, or
the account's. Account ids in every value appear as `<account>`.

## Answer and citations

The agent's text is the answer. It is normal Markdown; there is no answer tool
and no report block protocol, and a turn may hold several texts between tool
calls. The model may link a tool result by the actual evidence id from the
`<untrusted-data evidence="…">` tag, for example `[1](#ev-call_config_1)`. In
the window the link is a small button; clicking it opens that call's step in
place and scrolls to it. The app does not validate citations or names; a link
that matches no call is shown greyed as plain text, with a tooltip saying so.

Every call is a step in the conversation, where it happened, a call the
runaway ceiling blocked included: a state mark, the tool's label, target, note,
a status word when it did not finish, and its duration. An open step shows the
shaped result and, under `What the agent received`, the exact text the model
got. A tool's model text carries the data its view shows; when `bound()` cut it,
the note says `the agent got part of this result`. A running step shows
`Waiting for the first result.` until it settles. Live progress comes from
`ToolDetails.progress` and the live tool's note, redacted and bounded; raw tool
output never reaches the window. Failed, refused, stopped and timed-out calls
stay in place.

## Code mode (`query`)

The script runs in a QuickJS sandbox (`@earendil-works/pi-codemode`): no
`fetch`, `require`, `process`, timers or modules, and model access stays off.
Its only capabilities are the read-only primitives, all under the account and
its scope:

| Primitive | Reads |
|---|---|
| `buckets()` | ListBuckets, filtered by scope, with each bucket's region when the provider returns it |
| `list({bucket, prefix?, delimiter?, kind?, token?, max?})` | one page of ListObjectsV2, ListObjectVersions (delete markers included) or ListMultipartUploads; max 1,000 |
| `head({bucket, key})` | HeadObject; metadata keys, never values |
| `config({bucket, sections?})` | the same section reads as `config`, as S3 returns them |
| `account({read, bucket?, key?, days?, token?, region?})` | the same reads as `account`; AWS only |
| `inventory({bucket, maxRows?, full?})` | latest S3 Inventory manifest and one bounded page; `full` imports every manifest file into a dataset |
| `dataset({file, kind?})` | import one attached access log or inventory into a local SQLite dataset |
| `aggregate({file, metric, groupBy?, filters?, limit?})` | whitelisted aggregate over an imported dataset (≤1,000 groups, with `truncated`) |
| `rows({file, filters?, limit?, offset?})` | one redacted page (≤1,000) of an imported dataset's rows, with the next offset |

Budget per script: 2,000 calls, 500,000 listed items, 120 seconds and 256 MiB.
A `list` page is charged before the request; a `config` call is charged one call
per section. The script's length is not limited. The returned rows (at most 500
on the page, all of them sent to the model, up to 12 columns) are redacted; the
script and the buckets it read stay in the view as evidence.

`inventory` without `full` reads one page of the latest manifest (default 100
rows, max 1,000). A CSV page up to 32 MiB or a Parquet page up to 16 MiB is
accepted; a larger file is reported instead of silently cut. With `full: true`,
every manifest file is imported into a local dataset, bounded to 1,000 files,
128 MiB per file, 512 MiB total and 2,000,000 rows. The destination bucket must
be in scope.

## Rules the tools enforce

- A bucket outside `provider.scope.buckets` is refused before any request; the
  step is `refused` and the agent receives `Refused: …`.
- The harness blocks a call only past a runaway ceiling of **100** rounds of
  tool calls in one turn. There are no per-model budgets, and it never refuses
  a repeated call; how much to read is the agent's decision.
- `objects` and `list` are one page, not an exhaustive listing; the view and
  the model text say when more exist.
- `object.preview` reads the first 8 KiB of any object, whatever its declared
  type; bytes that are not text are reported as binary, not shown. The rest of
  the body is never downloaded. A tag or ACL read that fails says `not readable`.
- `probe` with a bucket is a storage read and obeys the scope. `addressing`
  retries HeadBucket with the other addressing style.
- `dataset` imports at most 2,000,000 rows; `aggregate` answers whitelisted
  metrics and dimensions and `rows` filters by whitelisted columns; neither
  accepts SQL.
- `note` is redacted and recorded as `author=agent`; an empty note fails. A
  bucket note needs a bucket name. Its length and the number of notes are not
  capped.

## Not available

No write, delete, copy, move, ACL change, lifecycle put, policy put, bucket
creation, full object download (beyond a bounded preview), shell, arbitrary SQL
or generic HTTP. An S3 API a provider does not implement is reported as
`provider_unsupported`; it is never simulated. Dataset import is limited to
attached task files, not arbitrary filesystem paths.
