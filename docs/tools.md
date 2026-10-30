# Tools

Ten tools in one pi extension (`runtime/agent.ts`): seven read and control
tools for storage and investigation, and three that extend the agent's own
work. `tools/registry.ts` lists the names; each tool's description, sent with
its schema, is where the model learns what it does. The prompt does not
prescribe a workflow.

| Tool | Kind | What it does |
|---|---|---|
| `call` | read | one read-only operation of a bundled AWS SDK client |
| `query` | read | a read-only JavaScript script over storage, datasets and memory |
| `probe` | read | one unsigned request to the account endpoint |
| `more` | read | the rest of a long result or a stored object body |
| `discover` | environment | services, read operations, tools and their contracts |
| `render` | compose | a declarative view document |
| `memory` | memory | JSON documents across tasks, searchable with read-only SQL |
| `tool` | extend | save, list, run and delete an agent-authored method |
| `delegate` | extend | a child agent with the same tools and scope |
| `ask` | control | ask the user and end the turn |

Every tool except `ask` goes through `agentTool()` (`tools/policy.ts`). It
writes an audit row, redacts, keeps a long result whole for `more`, wraps the
text in the untrusted-data envelope, and attaches a typed `view`, a `status`
(`running`, `done`, `failed`, `refused`, `stopped`) and an `evidenceId`. A
`ScopeError` (an operation that is not a read, a bucket outside scope) is
`refused`; a call ended by **Stop** is `stopped`; any other error is `failed`.
No tool sets a time limit of its own; Stop ends any call.

Tools return data, not judgements. The agent reads, decides what the data
means and writes any change as its own text.

## `call`

`call` (`tools/call.ts`, `s3/api.ts`) runs one operation of a bundled AWS SDK
client. The input is the operation's own, with the field names the SDK uses.
`checkCall()` runs before anything is sent.

- **Services.** `s3`, `s3control`, `sts`, `iam`, `organizations`, `kms`,
  `accessanalyzer`, `cloudwatch`, `cloudtrail`, `config`, `cloudfront`,
  `backup`, `securityhub`, `guardduty`, `sns` and `sqs`: the storage and the
  account around it. A service whose reads return secrets or run compute
  (Lambda, EC2, Secrets Manager, SSM, ECR, DynamoDB) is not bundled.
  `discover` lists the current set and each service's operations.
- **Reads only.** The operation's name must start with `Get`, `List`, `Head`,
  `Describe`, `Lookup`, `Search`, `Select`, `Simulate` or `BatchGet`. The
  `NEVER` list excludes reads that hand out credentials or start state on the
  service: STS `GetSessionToken`, `GetFederationToken`,
  `GetWebIdentityToken` and `GetDelegatedAccessToken`, and KMS
  `GetParametersForImport`. Anything else is refused. An unknown service or
  operation fails with the list of services or of that service's reads.
- **Scope.** On a scoped account, an S3 or S3 Control input whose `Bucket` is
  outside `scope.buckets` is refused. `Bucket` may be a name or a plain bucket
  ARN (`arn:aws:s3:::name`); any other ARN, such as an access point or
  outpost, is refused, because it reaches buckets the scope cannot see.
  `s3 ListBuckets` returns only the buckets in scope. Reads of other services
  are not filtered by bucket scope.
- **Account id.** Where the input says `<account>`, the caller's id from STS
  `GetCallerIdentity` is put in; S3 Control's `AccountId` is filled in when the
  input leaves it out. The id is used for that call only.
- **Response.** `$metadata` is dropped, dates become ISO strings, binary
  values become base64, and a field whose name says it is a policy is parsed
  from JSON or URL-encoded JSON. An object body that happens to be JSON stays
  text. `scrub()` replaces every 12-digit number, keys included, with
  `<account>`, whichever account it names, and `redact()` masks the account in
  ARNs.
- **Bodies.** A streamed body (`GetObject`) is written to
  `tasks/<conversation>/objects/<id>.bin` and the result carries a 64 KiB
  preview and a `ref`. The stream stops at `max_bytes` (default 1 MiB, which
  protects the user's disk; the agent raises it, or reads a `Range`) and says
  `more: true` when the object goes on. `more` reads any
  offset of the stored body. An event stream (`SelectObjectContent`) returns
  its record payloads as text up to `max_bytes` (default 1 MiB), and its other events as they
  came.
- **Errors.** `describeError()` gives a service error as
  `Code (HTTP n): message`, scrubbed. A denied read is the service's
  `AccessDenied`; an operation the endpoint does not implement is its own
  answer. Nothing is simulated.
- **Region and endpoint.** The region is the one named, else the account's,
  else `us-east-1`. `providers.clientFor` builds one client per account,
  service and region. A custom-endpoint account sends every service to that
  endpoint, and S3 Control uses the endpoint as given rather than an
  account-prefixed host. On AWS, IAM and Organizations use `us-east-1`.

## `query`

The script runs in a QuickJS sandbox (`@earendil-works/pi-codemode`): no
`fetch`, `require`, `process`, timers or modules, and no model access. Its
only capabilities are the read-only primitives below, called as
`tools.<name>()`, all under the account and its scope:

| Primitive | Does |
|---|---|
| `call({service, operation, input?, region?, maxBytes?})` | any read the `call` tool makes, under the same rules; an object `Body` comes back whole up to `maxBytes` (default 1 MiB) as `{text` or `base64, bytesRead, ref, more?}` |
| `read({name, offset?, length?})` | any stretch of a call's kept result (evidence id), an object body (`objects/…`) or an attachment (`attachment:<name>`) |
| `dataset({file? \| ref? \| bucket+key? \| bucket+prefix?, name?, format?, columns?, header?})` | imports an attachment, an object body, one object, or every object under a prefix (scope checked) into a dataset with every source column; `format` is `csv`, `tsv`, `jsonl`, `json`, `parquet`, `s3_access_log` or `lines`, detected when omitted; `columns` names a header-less CSV |
| `inventory({bucket, name?})` | finds the bucket's enabled S3 Inventory, reads its newest manifest and imports every file it lists with the manifest's `fileSchema`, each streamed to disk; source and destination bucket must be in scope |
| `sql({name, sql, params?})` | one `SELECT` (or `WITH … SELECT`) over a dataset's `rows` table, on a read-only connection; no second statement, no `load_extension`. A dataset imported by an earlier script of the task is found by name |
| `datasets()` | the task's datasets: name, format, source, rows and columns |
| `history({query?, task?})` | messages and answers of every task matching `query`, every task's title with neither, or one task's whole conversation |
| `discover({kind?, service?, operation?})` | services, read operations with their input and output members, or the tool names available |
| `memory({action, ...})` | the same memory actions as the `memory` tool |
| `render({doc})` | validates a view document and returns it as the script's value; an invalid one fails with what is wrong |

A script returns an array of flat rows, `{rows, chart: {label, value}}`, a view
document, or any other JSON value, which reaches the model as JSON;
`text("…")` adds a line of output. There is no
call budget and no time limit: a script runs until it returns or the user
stops it. Sandbox memory defaults to 1,024 MB; the agent sets it with
`memory_mb`. Every returned row reaches the model, in pieces past `PIECE`. The
window's view keeps the first 10,000 rows and marks the table truncated.
Returned strings are scrubbed and redacted.

## `render`

`render` takes `{title?, doc}` where `doc` is
`{version: 1, blocks: [...]}`. Blocks may nest arbitrarily and include:
`markdown`, `section`, `stack`, `row`, `table`, `chart` (bar, line, area or
point; an optional `series` column splits the data), `code`, `callout`, `kv`,
`tree`, `diff`, `timeline` and `link`.
`shared/view.ts` validates and sanitises the tree; the window owns rendering
and accessibility. A view is data, never HTML or executable code. Limits are
2 MiB, depth 12, 2,000 blocks, 20,000 table/chart rows and 10,000 tree nodes.
A view that cannot be drawn fails with every reason (`blocks[2].spec.mark must
be bar, line, area or point`); a block that is not drawn as given is named in
the result, so the agent can correct it. The same document can be returned by
`query` or an agent-authored method.

## `memory`

A separate `memory.sqlite` file stores arbitrary JSON documents:

| Action | Input | Result |
|---|---|---|
| `put` | `key`, `value?`, `text?`, `tags?`, `scope?` | writes or replaces one document |
| `get` | `key`, `scope?` | the document's value, key, `origin` and `updatedAt` |
| `list` | `scope?`, `prefix?`, `tag?` | every matching document, newest first; without `scope`, the user's and this task's |
| `search` | `query` | every document whose key or text contains it |
| `query` | `sql`, `params?` | rows from one read-only SELECT over `docs` |
| `delete` | `id` or `key` (+ `scope?`) | forgets one document |

`scope` is `task` (the current task; a delegated child shares it) or `user`
(the default). Each document records the task that wrote it (`origin`).
Memory outlives tasks and app versions. Memory content is not injected into
the prompt; the digest says only how many documents exist. The agent decides
when to recall. Settings lists every document with its key, scope and the task
that wrote it, and the user can forget one.

## `tool`

An agent-authored method is a JSON Schema and a JavaScript body. `save` writes
it; `list` returns its name, description, scope and update time; `run` checks
the arguments against the schema with Ajv and executes the body in the same
QuickJS sandbox as `query`; the body reads the validated arguments as `args`.
`delete` removes it. `scope` is `task` or `user`.
Task methods are deleted with the task. The body has the read-only primitives,
no network, filesystem, process, timers or modules. `memory_mb` sets the
sandbox memory. A method that returns a view document renders as a view; an
array of rows renders as a table; any other value reaches the model as JSON.

## `delegate`

`delegate` takes a self-contained `task` and an optional `title`. It creates a
child conversation with the same read-only tools, account scope and memory,
working in the same task: its folder, attachments, kept results, datasets,
task memory and methods. It waits for the child to settle and returns its
answer and call count. A child that ends its turn on `ask` returns its
question and options instead, for the parent to ask the user or to answer from
what it knows. The child cannot write. Delegation is foreground: the parent
waits; several `delegate` calls in one turn run at the same time; stopping the
parent stops the child. The window shows the child's request, every step and
its text inside the delegate step, live while it works, fifty steps at a time.
The child's conversation is owned by the task and is purged with it.

## `discover`

`discover` reads no storage. With no arguments it lists the bundled services.
With `service` it lists that service's read operations; with `service` and
`operation` it returns the operation's input and output member names, as the
bundled SDK models them. With `kind: "tools"` it lists the registered tools,
each with its own description, and the agent-authored methods; with `tool` it returns one tool's
schema and scope.

## `more`

Every result is written whole to
`tasks/<conversation>/results/<evidence>.txt`. The model gets at most one piece
(`PIECE`, 24,000 characters) at a time; a longer result's copy ends with the
number of characters left and the offset to read from, and the step note says
`the agent got the first part; the rest is kept`. `more` takes `evidence`,
`offset` and `length` (default one piece) and reads any stretch of a kept
result, again after a compaction too; a stored object body by its
`objects/<id>.bin` ref; or an attachment as `attachment:<name>`, at a byte
offset, without loading the whole file into memory. An attached image (PNG,
JPEG, GIF, WebP) comes back as an image to a model that takes images. The view
in the window holds the whole result.

## `probe`

One unsigned `HEAD` (default), `GET` or `OPTIONS` to the account's endpoint or
a host under it, such as a virtual-hosted bucket, with any `headers` the agent
chooses: an `Origin` and `Access-Control-Request-Method` for a CORS preflight,
a `Range`, a `Host`. A header that would carry a credential (`Authorization`,
`Cookie`, `X-Amz-Security-Token`, `X-Amz-Credential`, `X-Amz-Signature`,
`X-Amz-Date`, `X-Amz-Content-Sha256`) is refused and nothing is sent. An AWS account's endpoint is
`https://s3.<region>.amazonaws.com`, and any S3 host under `amazonaws.com` is
allowed. Any other host is refused. It returns the resolved addresses, HTTP
status, headers, the TLS certificate (protocol, subject, issuer, names,
validity, whether it was trusted) and DNS and total time, scrubbed. It sends
no credentials and reads nothing of the storage.

## `ask`

`ask` puts a question in the conversation, with up to six options. The turn
ends until the user answers; a click sends the option as the next message.
Typing an answer works the same way. `ask` reads nothing and is not audited.

## Answer and citations

The agent's text is the answer, in Markdown; a turn may hold several texts
between tool calls. The model may link a result by the evidence id in its
`<untrusted-data evidence="…">` tag, as `[1](#ev-<id>)`. In the window the
link is a small button that opens that call's step in place. A link that
matches no call is shown greyed, as plain text, with a tooltip saying so. The
app does not check names or rewrite the answer.

## Not available

No write, delete, copy, move, ACL change, policy put, bucket creation,
credential minting, shell, SQL that writes, signed HTTP or HTTP to any host
but the account's endpoint. A change the agent
writes is text for the user; the app never runs it.
