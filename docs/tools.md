# Tools

Eleven tools in one pi extension (`runtime/agent.ts`). `tools/registry.ts`
lists the names; each tool's description, sent with its schema, is its
contract and where the model learns what it does. The prompt does not list the
tools or prescribe a workflow.

| Tool | Kind | What it does |
|---|---|---|
| `call` | read | one read-only operation of a bundled AWS SDK client |
| `query` | read | a JavaScript script over many calls, datasets and the workspace |
| `probe` | read | one unsigned request to a public host or the account endpoint |
| `more` | read | any stretch of a kept result, body, attachment, workspace file or bundled skill |
| `workspace` | workspace | the agent's durable files and its own SQL database, across tasks |
| `self` | self | what the agent is and may do; rename or pin its task; propose account settings |
| `schedule` | time | work for later: a prompt that runs on its own, within a token budget |
| `notify` | voice | a system notification and an inbox entry for the user |
| `change` | proposal | propose one write; only the user's approval in the window runs it |
| `delegate` | extend | a child agent with the same tools and scope |
| `ask` | control | ask the user and end the turn |

Every tool except `delegate` and `ask` goes through `agentTool()`
(`tools/policy.ts`). It writes an audit row, redacts the whole result, keeps a
long result whole for `more`, wraps the text in the untrusted-data envelope,
and attaches a typed `view`, a `status` (`running`, `done`, `failed`,
`refused`, `stopped`) and an `evidenceId`. A `ScopeError` (an operation that is
not a read, a bucket outside scope, a write not on the allowlist) is
`refused`; a call ended by **Stop** is `stopped`; any other error is `failed`.
No tool sets a time limit of its own; Stop ends any call.

Tools return data, not judgements. The agent reads, decides what the data
means and says it. It never changes storage itself: `change` is a proposal
that runs only when the user approves it.

## `call`

`call` (`tools/call.ts`, `s3/api.ts`) runs one operation of a bundled AWS SDK
client. The input is the operation's own, with the field names the SDK uses.
`checkCall()` runs before anything is sent.

- **Services.** `s3`, `s3control`, `sts`, `iam`, `organizations`, `kms`,
  `accessanalyzer`, `cloudwatch`, `cloudtrail`, `config`, `cloudfront`,
  `backup`, `securityhub`, `guardduty`, `sns` and `sqs`: the storage and the
  account around it. A service whose reads return secrets or run compute
  (Lambda, EC2, Secrets Manager, SSM, ECR, DynamoDB) is not bundled.
  `query`'s `discover()` lists the current set and each service's operations;
  `self read` names the services.
- **Reads only.** The operation's name must start with `Get`, `List`, `Head`,
  `Describe`, `Lookup`, `Search`, `Select`, `Simulate` or `BatchGet`. The
  `NEVER` list excludes reads that hand out credentials or start state on the
  service: STS `GetSessionToken`, `GetFederationToken`,
  `GetWebIdentityToken` and `GetDelegatedAccessToken`, KMS
  `GetParametersForImport`, and S3 Control `GetDataAccess`. Anything else is
  refused. An unknown service or operation fails with the list of services or
  of that service's reads.
- **Input members.** `checkInput()` compares every input member with the
  operation's modelled input. A member the operation does not model is refused
  with the members it does, so a scope check never passes on a member the SDK
  would drop.
- **Scope.** A scoped account is authorization. A call runs only if it names
  an in-scope `Bucket` (S3 or S3 Control; a name or a plain bucket ARN), or is
  a listing filtered to the scope (`s3 ListBuckets`, `s3
  ListDirectoryBuckets`), or reveals no bucket (`sts GetCallerIdentity`,
  `s3control GetPublicAccessBlock`). Other services see across the account
  and are refused with the reason; so are access point and outpost ARNs and
  S3 Control calls by access point name.
- **Account id.** Where the input says `<account>`, the caller's id from STS
  `GetCallerIdentity` is put in; S3 Control's `AccountId` is filled in when the
  input leaves it out.
- **Response.** `$metadata` is dropped, dates become ISO strings, binary
  values become base64, and a field whose name says it is a policy is parsed
  from JSON or URL-encoded JSON. An object body that happens to be JSON stays
  text. `shape()` keeps every identifier as returned, redacts
  credential-shaped text and replaces the value of a field named like a
  secret.
- **Bodies.** A streamed body (`GetObject`) is written to
  `tasks/<conversation>/objects/<id>.bin` and the result carries a 64 KiB
  preview and a `ref`. The stream stops at `max_bytes` (default 1 MiB, which
  protects the user's disk; the agent raises it, or reads a `Range`) and says
  `more: true` when the object goes on. `more` reads any offset of the stored
  body. An event stream (`SelectObjectContent`) returns its record payloads as
  text up to `max_bytes` (default 1 MiB), and its other events as they came.
- **Errors.** `describeError()` gives a service error as
  `Code (HTTP n): message`, redacted. A denied read is the service's
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
only capabilities are the primitives below, called as `tools.<name>()`, all
under the account and its scope. Every storage primitive reads; only
`workspace()` writes, and only to the workspace.

| Primitive | Does |
|---|---|
| `call({service, operation, input?, region?, maxBytes?})` | any read the `call` tool makes, under the same rules; an object `Body` comes back whole up to `maxBytes` (default 1 MiB) as `{text` or `base64, bytesRead, ref, more?}` |
| `read({name, offset?, length?})` | any stretch of a call's kept result (evidence id), an object body (`objects/…`), an attachment (`attachment:<name>`), a workspace file (`workspace:<path>`) or a bundled skill (`skill:<name>`) |
| `dataset({rows? \| file? \| ref? \| bucket+key? \| bucket+prefix?, name?, scope?, format?, columns?, header?})` | imports rows a script computed, an attachment, an object body, one object, or every object under a prefix (scope checked) into a dataset with every source column; `format` is `csv`, `tsv`, `jsonl`, `json`, `parquet`, `s3_access_log` or `lines`, detected when omitted; `columns` names a header-less CSV; `scope: 'user'` keeps it across tasks in the workspace's `data/` (512 MiB each, 2 GiB total) |
| `inventory({bucket, name?})` | finds the bucket's enabled S3 Inventory, reads its newest manifest and imports every file it lists with the manifest's `fileSchema`, each streamed to disk; source and destination bucket must be in scope |
| `sql({name, sql, params?})` | one `SELECT` (or `WITH … SELECT`) over a dataset's `rows` table, on a read-only connection; no second statement, no `load_extension`. A dataset imported by an earlier script of the task is found by name; a kept dataset is found when the task has no dataset of that name |
| `datasets()` | the task's and the user's datasets: name, scope, format, source, rows and columns |
| `history({query?, task?})` | messages and answers of every task matching `query`, every task's title with neither, or one task's whole conversation |
| `discover({kind?, service?, operation?})` | services, read operations with their input and output members, or the tool names available |
| `workspace({action, path?, content?, to?, text?, sql?, params?})` | the same actions as the `workspace` tool: `list`, `read`, `write`, `append`, `move`, `delete`, `search`, `sql` on `db.sqlite` |
| `run({path, args?})` | runs a workspace script (`scripts/…js`) in a new sandbox with the same primitives; the script reads its arguments as `args` and returns a value |
| `render({title?, doc})` | validates a view document and returns it as the script's value; an invalid one fails with what is wrong |

A script returns an array of flat rows, `{rows, chart: {label, value}}`, a view
document, or any other JSON value, which reaches the model as JSON;
`text("…")` adds a line of output. There is no call budget and no time limit:
a script runs until it returns or the user stops it. Sandbox memory defaults
to 1,024 MB; the agent sets it with `memory_mb`. Every returned row reaches the
model, in pieces past one piece. The window's view keeps the first 10,000 rows
and marks the table truncated. Returned strings are redacted of secrets;
identifiers are kept.

### View documents

A view is `{version: 1, blocks: [...]}`. Blocks may nest arbitrarily and
include: `markdown`, `section`, `stack`, `row`, `table`, `chart` (bar, line,
area or point; an optional `series` column splits the data), `code`,
`callout`, `kv`, `tree`, `diff`, `timeline` and `link`. `shared/view.ts`
validates and sanitises the tree; the window owns rendering and
accessibility. A view is data, never HTML or executable code. Limits are
2 MiB, depth 12, 2,000 blocks, 20,000 table/chart rows and 10,000 tree nodes.
A view that cannot be drawn fails with every reason (`blocks[2].spec.mark must
be bar, line, area or point`). A script returns one with `render()`; a
`board/<name>.view.json` file in the workspace holds one for the board.

## `workspace`

The agent's folder, `<data>/workspace/` (`workspace.ts`,
`tools/workspace.ts`), kept across every task, which the user can open from
Settings → Workspace. The agent organises it as it sees fit; the tool's
description names the conventions:

| Path | Convention |
|---|---|
| `notes/` | what the agent knows about the user's accounts and decisions |
| `skills/` | Markdown with `name` and `description` front matter; listed in the prompt in later turns |
| `data/` | datasets; `dataset({scope: 'user'})` keeps its SQLite files here |
| `scripts/` | JavaScript a `query` runs with `run({path, args})` |
| `board/` | a `<name>.view.json` holding `{title, doc}` is pinned on Home's board; writing it again refreshes it |
| `exports/` | files for the user; each write gets a **Save** link in the conversation |
| `db.sqlite` | the agent's own SQL database |

| Action | Input | Result |
|---|---|---|
| `list` | `path?`, `depth?` (default 2) | every file and folder under the path, with size and time |
| `read` | `path` | the file's text; a long file reaches the model a piece at a time |
| `write` | `path`, `content` | writes the file whole, making its folders |
| `append` | `path`, `content` | appends to the file |
| `move` | `path`, `to` | moves a file or folder; the target must not exist |
| `delete` | `path` | deletes a file or folder |
| `search` | `text`, `path?` | every line that contains the text, case-insensitive, in text files up to 8 MiB (at most 200) |
| `sql` | `sql`, `params?` | one statement on `db.sqlite`, read or write; rows for a `SELECT`, `WITH`, `PRAGMA table_info` or `EXPLAIN`, else `{changes}` |

Paths are relative. An absolute path, a `..` that climbs out, or a path that
leaves the folder through a symbolic link is refused; `list` skips links.
Content is redacted of secrets before it is written, and so are string SQL
parameters. `sql` refuses `ATTACH`, `DETACH`, `load_extension` and
`VACUUM INTO`, so it reaches no file but its own. A Markdown file opens
rendered in the step; any other file opens as code. `more` reads any stretch
of a workspace file as `workspace:<path>`.

## `self`

| Action | Input | Does |
|---|---|---|
| `read` | — | the model the task runs on (provider, id, context window, thinking), the tokens this task has spent, the storage accounts (name, id, endpoint, region, how it signs in, scope, whether changes are allowed — never a key), the schedules, the app version, the workspace path, today's date and the bundled services |
| `title` | `title` | renames this task (up to 120 characters), at once |
| `pin` | `pinned` | pins or unpins this task, at once |
| `propose` | `provider_id`, `scope?`, `allow_changes?`, `reason` | proposes a new bucket scope (empty for every bucket) or turning approved changes on or off for an account |

A proposal is stored like a change (`kind: 'settings'`) and shown as a change
card with the account's setting now and after. It applies only when the user
approves it in the window; the turn ends on the proposal.

## `schedule`

| Action | Input | Does |
|---|---|---|
| `create` | `name`, `prompt`, `when`, `budget_tokens?` | creates a schedule and its own task, and returns when the first run is due |
| `list` | — | every schedule: name, prompt, cadence, budget, task, next and last run, last outcome |
| `cancel` | `name` | removes a schedule; its task and past runs stay |

`when` is `at <ISO time>` (once), `every <n>m`, `every <n>h`, `daily HH:MM` or
`weekly <day> HH:MM`, in the user's local time (`parseCadence` in
`runtime/schedules.ts`). A schedule runs at most every 5 minutes. A name is 2
to 60 letters, digits, spaces, dots, dashes or underscores, unique among
schedules. `budget_tokens` is at least 1,000; without one a run may use
100,000 tokens.

Each run is a turn in the schedule's own task, `Scheduled: <name>`, which the
user can open, steer or stop. The turn starts with the schedule's prompt, and
the model is told it is a scheduled run that nobody is watching and that
`notify` reaches the user. A run stops at its token budget while the task is
not the one open in the window, with a `budget` notice; once the user opens it
the budget no longer applies. A run that cannot start (no model, a window too
small) records why as the schedule's last outcome and tries again next time.
How runs are timed is in [architecture.md](architecture.md).

## `notify`

`notify {title, body}` adds an entry to the inbox on Home and shows a system
notification; clicking either opens the task. The title is cut at 120
characters and the body at 600. One run notifies at most once: a second
notification before the user's next message fails with the reason, so the
agent puts everything in one. When Settings turns notifications off, the
entry still reaches the inbox and the tool says so; it does not fail. A
scheduled task's runs reach the user only through `notify`; the app sends no
"finished" notification for them.

## `change`

`change {provider_id, service, operation, input, reason}` proposes one write
(`changes.ts`, `runtime/approvals.ts`). The model never holds a write-capable
client and nothing it writes or reads can approve.

1. **The account allows changes.** Settings → Storage accounts → *Allow
   changes I approve* is off by default. Without it the proposal fails with
   the reason; the agent may ask for it with `self propose`.
2. **The allowlist** (`WRITABLE`) is reversible bucket configuration only:
   S3 `PutPublicAccessBlock`, `DeletePublicAccessBlock`, `PutBucketPolicy`,
   `DeleteBucketPolicy`, `PutBucketOwnershipControls`, `PutBucketEncryption`,
   `PutBucketVersioning`, `PutBucketLifecycleConfiguration`,
   `DeleteBucketLifecycle`, `PutBucketCors`, `DeleteBucketCors`,
   `PutBucketLogging`, `PutBucketTagging` and `PutBucketAcl`, and S3 Control
   `PutPublicAccessBlock`. No object write, no delete of data, no IAM.
3. **Checks.** `checkChange()` refuses an operation off the allowlist, checks
   every input member against the operation's model, and on a scoped account
   requires an in-scope `Bucket`; an account-wide write (S3 Control) is
   refused on a scoped account. A `Policy` may be given as an object and is
   sent as JSON text.
4. **Snapshot.** The app reads the current state with the matching read
   (`GetBucketPolicy` for `PutBucketPolicy`, and so on) using the account's
   read credentials. "Not set" errors (`NoSuchBucketPolicy`, …) mean nothing
   was set. A change whose current state cannot be read is not proposed.
5. **Proposal.** The step is a change card: the exact call, the state now and
   after, and the reason. The turn ends until the user decides.
6. **Decision.** **Approve** (with a second click to confirm) and **Reject**
   go over IPC to the main process. Approve runs exactly the stored call, after
   the same checks, with the account's write profile or else its own
   credentials. The result or error is stored, and a message goes to the agent
   as the user's: `Approved: <title>. The app ran it (change <id>). Read again
   to verify it took effect.`, or that it failed, or `Rejected: <title>.`
7. **Roll back.** An applied change has **Roll back** (with a second click to
   confirm). It runs the inverse from the snapshot at once — put the old
   document back, or delete what did not exist (`DeleteBucketOwnershipControls`,
   `DeleteBucketEncryption`, `DeleteBucketTagging` and S3 Control
   `DeletePublicAccessBlock` run only as inverses) — records it as a
   `rollback` change, and tells the agent to read again. Versioning that was
   never enabled rolls back to `Suspended`.

A scheduled run may propose a change; nothing runs until a person approves
it.

## `delegate`

`delegate` takes a self-contained `task` and an optional `title`. It creates a
child conversation with the same reading tools and account scope — without
`change`, `schedule`, `notify`, `self` and `delegate`, so acting for the user
stays with the parent (`CHILD_DENIED`) — working in the same task: its folder, attachments, kept results and datasets; the workspace is
shared like any other run's. It waits for the child to settle and returns its
answer and call count. A child that ends its turn on `ask` returns its
question and options instead, for the parent to ask the user or to answer from
what it knows. Delegation is foreground: the parent waits; several `delegate`
calls in one turn run at the same time; stopping the parent stops the child.
The window shows the child's request, every step and its text inside the
delegate step, live while it works, fifty steps at a time. The child's
conversation is owned by the task and is purged with it.

## `more`

Every result is redacted whole and then written to
`tasks/<conversation>/results/<evidence>.txt`. The model gets at most one piece
(`pieceFor`: about a fifth of the context window, at most `PIECE`, 24,000
characters) at a time; a longer result's copy ends with the number of
characters left and the offset to read from, and the step note says `the agent
got the first part; the rest is kept`. `more` takes `evidence`, `offset` and
`length` (default one piece) and reads any stretch of:

- a kept result by its evidence id, again after a compaction too;
- a stored object body by its `objects/<id>.bin` ref;
- an attachment as `attachment:<name>`;
- a workspace file as `workspace:<path>`;
- a bundled skill as `skill:<name>`.

Files and bodies are read at a byte offset without loading the whole file. A
text piece is extended to the end of its line (by up to 16 KiB), so a secret on
one line is never cut in two; the next piece starts on the following line. An
image (PNG, JPEG, GIF, WebP) comes back as an image to a model that takes
images. The view in the window holds the whole result.

## `probe`

One unsigned `HEAD` (default), `GET` or `OPTIONS` to any public host — the
account's endpoint, a virtual-hosted bucket, a website endpoint, a CloudFront
or custom domain — with any `headers` the agent chooses: an `Origin` and
`Access-Control-Request-Method` for a CORS preflight, a `Range`, a `Host`. A
header that would carry a credential (`Authorization`, `Cookie`,
`X-Amz-Security-Token`, `X-Amz-Credential`, `X-Amz-Signature`, `X-Amz-Date`,
`X-Amz-Content-Sha256`) is refused and nothing is sent. Every address the host
resolves to must be public, unless it is the account's own custom endpoint (a
local MinIO); the connection is pinned to the checked address and redirects
are not followed. It returns the resolved addresses, HTTP status, headers, the
TLS certificate (protocol, subject, issuer, names, validity, whether it was
trusted), the first 4 KiB of a GET's body, and DNS and total time. It stops
reading a body once it has 4 KiB. It sends no credentials and reads nothing of
the storage.

## `ask`

`ask` puts a question in the conversation, with optional answer buttons and a
note. The turn
ends until the user answers; a click sends the option as the next message.
Typing an answer works the same way. `ask` reads nothing and is not audited.

## Skills

Skills are Markdown notes on how to work a kind of storage question. Bundled
skills ship in `main/skills/*.md` (public access, cross-account access,
encryption, identities and keys, change history, cost and lifecycle, data at
scale, S3-compatible endpoints, proposing changes) and are copied to
`<data>/bundled-skills/` at launch. The prompt's `skills` section lists them
by name and description; the agent reads one with `more` as `skill:<name>`.
Skills in the workspace's `skills/` are listed too, inside an untrusted-data
block, and read with `workspace`. A workspace skill never replaces a bundled
one: both are listed. A skill is advice: the app never runs or checks one.

## Answer and citations

The agent's text is the answer, in Markdown; a turn may hold several texts
between tool calls. The model may link a result by the evidence id in its
`<untrusted-data evidence="…">` tag, as `[1](#ev-<id>)`. In the window the
link is a small button that opens that call's step in place. A link that
matches no call is shown greyed, as plain text, with a tooltip saying so. The
app does not check names or rewrite the answer.

## Not available

No object write, copy or delete, no bucket creation or deletion, no IAM
change, no credential minting, no shell, no signed HTTP and no HTTP to a
private address but the account's endpoint. A write outside the `change`
allowlist, or on an account that does not allow changes, is text the agent
writes for the user; the app never runs it.

## Over MCP

`storage-agent --mcp` serves `call`, `query`, `probe`, `more` and `workspace`
to another agent over stdio (`mcp.ts`). Only the workspace's `list`, `read`
and `search` run there. `change`, `schedule`, `notify`, `self`, `delegate` and
`ask` are window-only. See [architecture.md](architecture.md).
