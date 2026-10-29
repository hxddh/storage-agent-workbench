# Tools

Six tools in one pi extension (`runtime/agent.ts`): `call` (any read-only
operation), `query` (a read-only script), `probe` (one unsigned request to the
account's endpoint), `more` (the rest of a long result), `note` (memory) and
`ask`. `tools/registry.ts` lists the names; each tool's description, sent with
its schema, is where the model learns what it does.

Every tool except `ask` goes through `agentTool()` (`tools/policy.ts`). It
writes an audit row, redacts, keeps a long result whole for `more`, wraps the
text in the untrusted-data envelope, and attaches a typed `view`, a `status`
(`running`, `done`, `failed`, `refused`, `stopped`) and an `evidenceId`. A
`ScopeError` (an operation that is not a read, a bucket outside scope) is
`refused`; a call ended by **Stop** is `stopped`; any other error is `failed`.
No tool sets a time limit of its own; Stop ends any call.

Tools return data, not judgements. The agent reads, decides what the data
means and writes any change as its own text.

| Tool | Input | What the model gets | View |
|---|---|---|---|
| `call` | `provider_id?`, `service`, `operation`, `input?`, `region?`, `max_bytes?` | the response as JSON, or `Code (HTTP n): message` | `raw`: the response |
| `query` | `provider_id?`, `title?`, `code`, `memory_mb?` | every returned row, the call count and script output | `query`: table, bar chart, script, output, buckets read |
| `probe` | `provider_id?`, `url?`, `method?` (`HEAD`/`GET`) | addresses, status, headers, TLS certificate and timing, as JSON | `raw` |
| `more` | `evidence`, `offset` | the next piece of a kept result and where it ends | `note`: the character range |
| `note` | `text?` or `forget?` | `Remembered: <text>` or `Forgot: <text>` | `note` |
| `ask` | `question`, `options?` (up to 6), `note?` | `Question asked.`; the turn ends until the user answers | `question` |

`provider_id` (an account id or name) is optional when one account exists.

## `call`

`call` (`tools/call.ts`, `s3/api.ts`) runs one operation of a bundled AWS SDK
client: `s3`, `s3control`, `sts`, `iam`, `organizations`, `kms`,
`accessanalyzer`, `cloudwatch`, `cloudtrail`. The input is the operation's
own, with the field names the SDK uses. `checkCall()` runs before anything is
sent.

- **Reads only.** The operation's name must start with `Get`, `List`, `Head`,
  `Describe`, `Lookup`, `Search`, `Select` or `Simulate`. The `NEVER` list
  excludes reads that hand out credentials or start state on the service:
  STS `GetSessionToken`, `GetFederationToken` and `GetWebIdentityToken`, and
  KMS `GetParametersForImport`. Anything else is refused. An unknown service
  or operation fails with the list of services or of that service's reads.
- **Scope.** On a scoped account, an S3 or S3 Control input whose `Bucket` is
  outside `scope.buckets` is refused. `Bucket` may be a name or a plain bucket
  ARN (`arn:aws:s3:::name`); any other ARN, such as an access point or
  outpost, is refused, because it reaches buckets the scope cannot see.
  `s3 ListBuckets` returns only the buckets in scope.
- **Account id.** Where the input says `<account>`, the caller's id from STS
  `GetCallerIdentity` is put in; S3 Control's `AccountId` is filled in when the
  input leaves it out. The id is used for that call only.
- **Response.** `$metadata` is dropped, dates become ISO strings, binary
  values become base64, policy documents that arrive as JSON or URL-encoded
  JSON strings are parsed, and `scrub()` turns every 12-digit number, keys
  included, into `<account>`.
- **Bodies.** A streamed body (`GetObject`) is read up to `max_bytes`
  (default 1 MiB, `DEFAULT_BODY_BYTES`) and the stream is closed: text as
  text, anything else as base64, with `bytesRead` and `more: true` when bytes
  were left. `Range` reads a part. An event stream (`SelectObjectContent`)
  returns its record payloads as text up to the same limit, and its other
  events as they came.
- **Errors.** `describeError()` gives a service error as
  `Code (HTTP n): message`, scrubbed. A denied read is the service's
  `AccessDenied`; an operation the endpoint does not implement is its own
  answer. Nothing is simulated.
- **Region and endpoint.** The region is the one named, else the account's,
  else `us-east-1`. `providers.clientFor` builds one client per account,
  service and region. A custom-endpoint account sends every service to that
  endpoint, and S3 Control uses the endpoint as given rather than an
  account-prefixed host. On AWS, IAM and Organizations use `us-east-1`. S3
  clients follow region redirects and make up to two attempts; the other
  clients make up to three. No request has a fixed timeout; Stop ends one.

## Results longer than one piece

The model gets at most one piece (`PIECE`, 24,000 characters) of a result at
a time. A longer result is written whole to
`tasks/<conversation>/results/<evidence>.txt`; the model's copy ends with the
number of characters left and the offset to read from, and the step note says
`the agent got the first part; the rest is kept`. `more` reads 24,000
characters from any offset. The view in the window holds the whole result.

## Answer and citations

The agent's text is the answer, in Markdown; a turn may hold several texts
between tool calls. The model may link a result by the evidence id in its
`<untrusted-data evidence="…">` tag, as `[1](#ev-<id>)`. In the window the
link is a small button that opens that call's step in place. A link that
matches no call is shown greyed, as plain text, with a tooltip saying so. The
app does not check citations or names.

## Code mode (`query`)

The script runs in a QuickJS sandbox (`@earendil-works/pi-codemode`): no
`fetch`, `require`, `process`, timers or modules, and no model access. Its
only capabilities are four read-only primitives, called as `tools.<name>()`,
all under the account and its scope:

| Primitive | Does |
|---|---|
| `call({service, operation, input?, region?, maxBytes?})` | any read the `call` tool makes, under the same rules |
| `dataset({file, kind?})` | imports one attached access log or inventory into a local SQLite dataset |
| `inventory({bucket})` | finds the bucket's enabled S3 Inventory, reads its newest manifest and imports every file it lists, each streamed to disk; source and destination bucket must be in scope |
| `sql({file, sql, params?})` | one `SELECT` (or `WITH … SELECT`) over the dataset's `rows` view, on a read-only connection; no second statement, no `load_extension` |

A script returns an array of flat rows, or `{rows, chart: {label, value}}`;
`text("…")` adds a line of output. There is no call budget and no time limit:
a script runs until it returns or the user stops it. Sandbox memory defaults
to 1,024 MB (`SANDBOX.memoryMb`); the agent sets it with `memory_mb`. Every
returned row reaches the model, in pieces past `PIECE`. The window's view
keeps the first 10,000 rows (`SANDBOX.viewRows`) and marks the table
truncated. Returned strings are scrubbed and redacted.

## `probe`

One unsigned `HEAD` (default) or `GET` to the account's endpoint or a host
under it, such as a virtual-hosted bucket. An AWS account's endpoint is
`https://s3.<region>.amazonaws.com`, and any S3 host under `amazonaws.com` is
allowed. Any other host is refused. It returns the resolved addresses, HTTP
status, headers, the TLS certificate (protocol, subject, issuer, names,
validity, whether it was trusted) and DNS and total time, scrubbed. It sends
no credentials and reads nothing of the storage.

## `note`

`note` with `text` writes a redacted note; an empty note fails. `note` with
`forget` deletes a note by the id the digest shows. Neither length nor count is
capped.

## Not available

No write, delete, copy, move, ACL change, policy put, bucket creation,
credential minting, shell, SQL that writes or generic HTTP. Dataset import
reads only files attached to the task and S3 Inventory.
