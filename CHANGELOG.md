## 40.0.0 — 2026-10-30

The agent reaches all of what it was given, and is told enough to correct
itself.

- **Datasets keep every column.** `dataset()` imports an attachment, an
  object body, one object or every object under a prefix into a `rows` table
  with the source's own columns: a CSV's header, every JSON key, a Parquet
  schema, every field of an S3 server access log plus the raw line, or plain
  lines. `inventory()` imports a report with the schema its manifest names
  (encryption, replication, Object Lock, versions and the rest). Nothing is
  dropped, masked or cut: client addresses are kept. Strings are scrubbed as
  every read is. `sql()` finds a dataset by name from any script of the task;
  `datasets()` lists them. v39's two fixed schemas, IP masking and 500-character
  cuts are gone.
- **Scripts read object contents.** A script's `call()` gets a body whole up to
  `maxBytes` (default 1 MiB), not a 64 KiB preview; `read()` reads any stretch
  of a kept result, an object body or an attachment. A script may return any
  JSON value.
- **Attachments are readable.** A message names its files as
  `attachment:<name>`; `more` reads any stretch of them, and an attached image
  is shown to a model that takes images.
- **Child agents work in the task.** A delegated child uses its task's folder,
  attachments, results, datasets and task memory; its steps show live in the
  parent's step, fifty at a time; a question it would ask comes back to the
  parent instead of "(no answer)".
- **Every result is kept.** `more` reads any call again by its evidence id,
  after a compaction too, with a `length` the agent chooses.
- **Tools say why.** `render` names each invalid block and what was not drawn;
  `probe` names a refused header.
- **`probe` sends OPTIONS and headers**, so a CORS preflight is one probe; a
  credential header is refused.
- **`history()`** reads what earlier tasks asked and answered.
- **Memory outlives versions.** A schema reset clears tasks and task-scoped
  documents, not the user's memory. `memory` gains `search`; a list returns
  every match (yours and this task's without a scope); each document records
  the task that wrote it, shown in Settings.
- **Model limits are the provider's.** The output limit is halved until the
  provider accepts when its refusal names no number (no 32k guess); the
  context window is what the provider's model list states.
- **Schema 20.** `datasets` gains `name`, `format` and `source`.

## 39.0.0 — 2026-10-29

v38's tools stay; the limits, history and gaps it brought back are gone.

- **No output cap.** Each model's output maximum is learned from its provider
  again (`learnOutputLimit`); v38's fixed `min(8,192, context window)` cap,
  which also held reasoning to about 7k tokens, is removed.
- **A body read protects the disk.** `GetObject` and event streams stop at
  `max_bytes`, default 1 MiB, the agent's to raise; a `Range` reads any part.
  v38 streamed a whole object of any size to the task folder.
- **Every account id is scrubbed.** `scrub()` replaces every 12-digit number,
  whichever account it names (organization members, cross-account principals,
  ids inside CloudTrail events), as the contract says. v38 replaced only the
  caller's id and a few field names.
- **Services are the storage and the account around it.** S3, S3 Control, STS,
  IAM, Organizations, KMS, Access Analyzer, CloudWatch, CloudTrail, Config,
  CloudFront, Backup, Security Hub, GuardDuty, SNS and SQS. Lambda, EC2,
  DynamoDB, RDS, Route 53, ECR, Secrets Manager, SSM, Service Quotas, Support
  and Cost Explorer are no longer bundled: their reads return secrets
  (function environments, user data, console output, command output, layer
  URLs), table items, or cost money. Reads are Get, List, Head, Describe,
  Lookup, Search, Select, Simulate and BatchGet; STS `GetDelegatedAccessToken`
  joins the refused credential reads.
- **No history.** Schema 19; a database at any other version starts over, with
  `tasks/` and `memory.sqlite`. The v17 migration, the database and `tasks/`
  backups, the v37 notes import and the `notes` table are gone.
- **Child agents are visible.** A `delegate` step shows the child's request,
  every step (each opens like any other) and its text. Stopping the parent
  stops the child.
- **The prompt does not list the tools.** The capabilities section is gone;
  each tool describes itself. `discover` lists the registered tools from the
  registry, and for one operation returns its input and output member names
  from the SDK model.
- **Memory and methods.** Memory lists and searches return every match (no
  100- or 500-row cap, no 500-character text cut); `%` and `_` match only
  themselves; a document records the task that wrote it, and a recall carries
  it. The memory file has its own schema version. A method's code and schema
  have no size cap, and an account in an ARN is stored as `<account>`, which
  `call` fills in.
- **Links show where they go.** A view's link shows its host, and its URL on
  hover.

## 38.0.0 — 2026-10-29

The agent owns more of its own work, and the window shows less app machinery.

- **Ten tools.** `call`, `query`, `probe`, `more`, `discover`, `render`,
  `memory`, `tool`, `delegate` and `ask`. `discover` exposes the environment;
  `render` composes a declarative view; `memory` stores arbitrary JSON across
  tasks; `tool` saves a reusable read-only method; `delegate` gives an
  independent investigation to a child agent with the same tools and scope.
- **Twenty-seven service clients.** S3, S3 Control, STS, IAM, Organizations,
  KMS, Access Analyzer, CloudWatch, CloudTrail, EC2, Lambda, DynamoDB, RDS,
  CloudFront, Route 53, Config, Security Hub, GuardDuty, ECR, SNS, SQS,
  Secrets Manager, SSM, Service Quotas, Support, Backup and Cost Explorer.
  Reads include `BatchGet`, `Query` and `Scan`.
- **Memory is a separate database.** `memory.sqlite` holds JSON documents with
  keys, tags, task or user scope, list/get/query/delete and read-only SQL. The
  prompt says how many documents exist, never their content. v37 notes are
  imported once and cleared. Settings lists every document and can forget one.
- **Agent-authored methods.** `tool` saves a JSON Schema and a JavaScript body,
  runs it in the same QuickJS sandbox as `query`, and stores task or user
  methods in `agent_tools`. Settings lists them and their code.
- **Views are data.** `render` and `query` can return a validated `ViewDoc`
  with Markdown, tables, charts, trees, timelines, diffs, callouts, key-value
  rows and code. The window renders blocks; it never evaluates the document.
- **Child agents.** `delegate` runs a foreground child conversation with the
  same read-only tools, account scope and memory, and returns its answer as a
  step.
- **Object bodies stream.** A `GetObject` body is written to the task folder;
  the result carries a 64 KiB preview and a ref, and `more` reads any offset.
  `max_bytes` can stop the stream earlier.
- **No hidden output probe.** The model's output budget is a bounded default
  of `min(8,192, context window)` tokens. The dead `learnOutputLimit` path
  is gone.
- **Schema 18.** `agent_tools` is added; 17 migrates in place. Older
  incompatible layouts are backed up before reset, and `tasks/` is renamed,
  not deleted.
- **Window.** A method, memory, view or delegate result has its own step view.
  Raw JSON arguments are no longer repeated for meta tools. Settings gains
  Methods and lists memory documents by key and scope. The close control stays
  at the top left.
- **Safety.** `scrub()` removes the caller's actual account id and account
  fields, not every 12-digit number. Policy parsing is limited to policy-shaped fields. ARN
  redaction preserves the IAM ARN prefix. Memory SQL cannot reach host tables.
  Secret-store and registry-credential reads (ECR, Secrets Manager and SSM
  parameters) are refused.
- **Quality.** Unit tests, E2E render/method/delegate paths, visual baselines,
  budget, contrast, audit, SBOM and the smoke eval/bench run in CI. The visual
  gate now fails on a missing capture instead of skipping it.

## 37.0.0 — 2026-10-29

Storage Agent is a local, read-only agent for object storage. The agent reads,
judges and says what it found; the app gives it read-only tools that return
what the services return, keeps the safety boundaries, and shows every call in
the conversation where it happened.

- **One read-only `call`.** Any operation of S3, S3 Control, STS, IAM,
  Organizations, KMS, Access Analyzer, CloudWatch or CloudTrail whose name says
  it reads (Get, List, Head, Describe, Lookup, Search, Select, Simulate), except
  the few that hand out credentials, with the operation's own input. The
  response comes back as JSON, or the service's error code, HTTP status and
  message. A body or event stream is read up to `max_bytes` (default 1 MiB, the
  agent's choice). A custom-endpoint account answers every service at its own
  endpoint; its credentials are never sent to AWS.
- **`query`** runs a read-only JavaScript script in a QuickJS sandbox with
  `call()`, `dataset()`, `inventory()` and read-only `sql()`. It runs until it
  returns or the user stops it; sandbox memory defaults to 1 GiB and the agent
  can raise it.
- **`probe`** sends one unsigned request to the account's endpoint and returns
  what came back: addresses, status, headers, certificate and timing.
- **`more`** reads the rest of a result longer than 24,000 characters; nothing
  a tool returned is out of the agent's reach.
- **`note`** remembers text and forgets the agent's own notes; every note is in
  the prompt with its id. **`ask`** asks the user.
- **No harness limits.** No round ceiling, no tool timeout, no fixed output cap
  (each model's maximum is learned from its provider). Stop is the user's
  control.
- **Safety.** Read-only by operation name; bucket scope checked before any
  bucket call; secrets sealed in the vault; account ids scrubbed from every
  response; tool output inside `<untrusted-data>`, redacted.
- **Data.** One schema; a database of any other layout starts over.
