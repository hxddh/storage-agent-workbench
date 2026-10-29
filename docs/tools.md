# Tools

Six tools in one pi extension (`runtime/agent.ts`): `call` (any read-only
operation), `query` (a read-only script), `probe` (one unsigned request to the
account's endpoint), `more` (the rest of a long result), `note` (memory) and
`ask`. `tools/registry.ts` lists the names; each tool's description, sent with
its schema, is the only place the model learns what it does. Every tool except
`ask` goes through `agentTool()` (`tools/policy.ts`), which writes an audit
row, redacts, keeps a long result whole for `more`, wraps the text in the
untrusted-data envelope, and attaches a typed `view`, a `status` (`done`,
`failed`, `refused`, `timeout`, `stopped`) and an `evidenceId`. No tool sets a
timeout; Stop ends any call.

Tools return data, not judgements. There is no rule engine, no Issue, no
exposure verdict and no change-plan generator: the agent reads, decides what
the data means and writes any change as its own text. 37.0 removed `buckets`,
`objects`, `object`, `config` and `account` (36.0 removed `survey`, `estate`,
`change_plan` and `accept_risk`); calls to them in older tasks still show as
steps with what the agent received.

| Tool | Input | Model output | View |
|---|---|---|---|
| `call` | `provider_id?`, `service`, `operation`, `input?`, `region?`, `max_bytes?` | the response as JSON, or the error's code, HTTP status and message | `raw`: the response as JSON |
| `query` | `provider_id?`, `title?`, `code`, `memory_mb?` | every returned row, the call count and script output | `query`: table, bar chart, script, buckets read |
| `probe` | `provider_id?`, `url?`, `method?` (`HEAD`/`GET`) | addresses, HTTP status, headers, TLS certificate and timing, as JSON | `raw` |
| `more` | `evidence`, `offset` | the next piece of a kept result, and where it ends | `note`: the character range |
| `note` | `text?` or `forget?`, `scope?` (`estate`/`provider`/`bucket`), `bucket?`, `provider_id?` | `Remembered (<scope>): <text>` or `Forgot: <text>` | `note` |
| `ask` | `question`, `options?` (≤6), `note?` | the question; the turn ends until the user answers | `question`: the question as an agent message, with a button per option |

## `call`

`call` (`tools/call.ts`, `s3/api.ts`) runs one operation of a bundled AWS SDK
client: `s3`, `s3control`, `sts`, `iam`, `organizations`, `kms`,
`accessanalyzer`, `cloudwatch`, `cloudtrail`. The input is the operation's own,
as the SDK names its fields.

- **Reads only.** The operation's name must start with `Get`, `List`, `Head`,
  `Describe`, `Lookup`, `Search`, `Select` or `Simulate`. `NEVER` excludes the
  reads that hand out credentials or start service-side state: STS
  `GetSessionToken`, `GetFederationToken` and `GetWebIdentityToken`, and KMS
  `GetParametersForImport`. Anything else is refused before a request. An
  unknown operation fails with the service's list of reads.
- **Scope.** An S3 or S3 Control input whose `Bucket` (a name or a bucket ARN)
  is outside `scope.buckets` is refused. `s3 ListBuckets` returns only the
  buckets in scope.
- **Account id.** Where the input says `<account>`, the caller's id from STS
  `GetCallerIdentity` is put in; S3 Control's `AccountId` is filled in when the
  input leaves it out. The id is used for that call only.
- **Response.** `$metadata` is dropped, dates become ISO strings, policy
  documents that arrive as JSON or URL-encoded JSON strings are parsed, and
  `scrub()` turns every 12-digit number into `<account>`, keys included.
- **Bodies.** A streamed body (`GetObject`) is read up to `max_bytes` (default
  1 MiB, `DEFAULT_BODY_BYTES`) and then closed: text as text, anything else as
  base64, with `more: true` when bytes were left. Use `Range` to read a part.
- **Errors.** A service error comes back as `Code (HTTP n): message`, scrubbed.
  A denied read is `AccessDenied`; an API the provider does not implement is
  its own answer (`NotImplemented`, 501, 405). Nothing is simulated.
- **Region and endpoint.** The region is the one named or the account's.
  `providers.clientFor` builds the client: a custom-endpoint account sends
  every service to that endpoint, its credentials never sent to AWS; on AWS,
  IAM and Organizations use `us-east-1`.

## Results longer than one piece

The model gets at most one piece (`PIECE`, 24,000 characters) of a result at a
time. A longer result is written whole to
`tasks/<conversation>/results/<evidence>.txt` (`resultPath`, `fitPiece`), the
model's copy ends with the number of characters left and the offset to read
from, and the step note says `the agent got the first part; the rest is kept`.
`more` reads the next piece from any offset; nothing a tool returned is out of
the agent's reach. The view in the window holds the whole result.

## Answer and citations

The agent's text is the answer. It is normal Markdown; there is no answer tool
and no report block protocol, and a turn may hold several texts between tool
calls. The model may link a tool result by the actual evidence id from the
`<untrusted-data evidence="…">` tag, for example `[1](#ev-<id>)`. In the
window the link is a small button; clicking it opens that call's step in place
and scrolls to it. The app does not validate citations or names; a link that
matches no call is shown greyed as plain text, with a tooltip saying so.

Every call is a step in the conversation, where it happened: a state mark, the
tool's label, target, note, a status word when it did not finish, and its
duration. An open step shows the shaped result and, under `What the agent
received`, the exact text the model got. A running step shows `Waiting for the
first result.` until it settles. Live progress comes from
`ToolDetails.progress` and the live tool's note, redacted and bounded; raw tool
output never reaches the window. Failed, refused and stopped calls stay in
place.

## Code mode (`query`)

The script runs in a QuickJS sandbox (`@earendil-works/pi-codemode`): no
`fetch`, `require`, `process`, timers or modules, and model access stays off.
Its only capabilities are four read-only primitives, all under the account and
its scope:

| Primitive | Does |
|---|---|
| `call({service, operation, input?, region?, maxBytes?})` | any read `call` makes, under the same rules |
| `dataset({file, kind?})` | import one attached access log or inventory into a local SQLite dataset |
| `inventory({bucket})` | find the bucket's enabled S3 Inventory, read its latest manifest and import every file it lists; each file streams to disk, never whole into memory. The destination bucket must be in scope |
| `sql({file, sql, params?})` | one `SELECT` (or `WITH … SELECT`) over the dataset's `rows` view, on a read-only SQLite connection; no second statement, no `load_extension` |

There is no call or listing budget and no time limit: a script runs until it
returns or the user stops it. The sandbox's memory defaults to 1,024 MB
(`SANDBOX.memoryMb`); the agent raises it with `memory_mb`. Imports have no
row cap. Every returned row reaches the model (in pieces past `PIECE`); the
window's view keeps the first 10,000 rows (`SANDBOX.viewRows`) and marks the
table truncated. Returned strings are redacted; the script and the buckets it
read stay in the view.

## `probe`

One unsigned `HEAD` (default) or `GET` to the account's endpoint, or to a host
under it such as a virtual-hosted bucket; on AWS, any S3 host. It returns the
resolved addresses, HTTP status, headers, the TLS certificate (subject, issuer,
names, validity, whether it was trusted) and DNS and total time. It carries no
credentials, reads nothing of the storage and says nothing is `ok` or `fail`.

## `note`

`note` with `text` writes a redacted note with `author = 'agent'`; an empty
note fails, and a bucket note needs a bucket name. `note` with `forget` deletes
a note the agent wrote, by the id the digest shows; a user's note is refused.
Neither length nor count is capped.

## Not available

No write, delete, copy, move, ACL change, lifecycle put, policy put, bucket
creation, credential minting, shell, SQL that writes or generic HTTP. Dataset
import is limited to attached task files and S3 Inventory, not arbitrary
filesystem paths.
