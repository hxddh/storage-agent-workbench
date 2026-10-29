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
