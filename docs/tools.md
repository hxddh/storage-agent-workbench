# Tools

Ten tools, all read-only, all registered in one pi extension
(`runtime/agent.ts`). Every call goes through `agentTool()`, which applies the
account scope, a timeout, an audit row, redaction and the untrusted-data
envelope, and attaches a typed `view` and a `status` (`done`, `failed`,
`refused`, `timeout`, `stopped`) for the window.

| Tool | Input | Model output | View |
|---|---|---|---|
| `survey` | `provider_id?`, `buckets?` (≤50), `limit?` (≤500) | buckets read, public, undecided rules per bucket, issue delta, what was not read | bucket table, open and accepted Issues, observations, coverage |
| `buckets` | `provider_id?` | names | name + created |
| `objects` | `bucket`, `prefix?`, `kind?` (`keys`/`versions`/`uploads`), `limit?` (≤200) | count | key table |
| `object` | `bucket`, `key`, `aspects?` (`head`/`tags`/`acl`/`preview`) | facts | fact list, bounded text preview |
| `config` | `bucket`, `aspect?` (`security`/`lifecycle`/`observability`) | findings, blind spots, rules proved clean | finding list, observations |
| `probe` | `provider_id?`, `bucket?`, `check?` (`reach`/`tls`/`latency`/`location`/`addressing`) | check outcomes | check list |
| `estate` | `provider_id?`, `bucket?`, `notes?` | remembered buckets with their age, Issues with evidence, notes | bucket table, Issues, notes |
| `fix` | `bucket`, `code` (an open or accepted Issue) | CLI command, notes, impact | CLI/Terraform/API tabs, impact |
| `analyze` | `file`, `kind?`, `metric?`, `group_by?`, `filters?`, `limit?` | aggregates only | table + bar chart |
| `note` | `text`, `scope?`, `bucket?`, `provider_id?` | confirmation | note text |

## Rules the tools enforce

- A bucket outside `provider.scope.buckets` is refused before any request.
- `survey` and `config` read through `s3/facts.ts` and decide rules from facts;
  a blind read decides nothing. `survey` remembers each bucket as soon as it is
  read, stops starting buckets 20 s before its 300 s timeout, and reports the
  rest as not read. Only a complete, unscoped listing marks a bucket gone.
- The harness blocks a storage read repeated with the same arguments in one run
  (`estate`, `fix` and `note` may repeat) and every call after 24 rounds.
- `object.preview` reads at most 8 KiB and only for text-like content types under
  1 MiB; the body of a large object is never downloaded.
- `analyze` imports at most 2,000,000 rows and answers only whitelisted metrics
  and dimensions; it never accepts SQL.
- `note` is capped at 1,000 characters and 500 notes; it is redacted and
  recorded as `author=agent`.
- `survey` opens and resolves Issues through `estate`, never through prose.

## Not available

No write, delete, copy, move, ACL change, lifecycle put, policy put, bucket
creation, object download (beyond a bounded preview), shell, arbitrary SQL or
generic HTTP. An S3 API a provider does not implement is reported as
`provider_unsupported`; it is never simulated.
