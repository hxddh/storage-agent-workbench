# Storage Agent

A local, read-only agent for S3-compatible object storage and the cloud around
it. You talk with the agent; it decides what to read, how to investigate and
what to say. A **task** is one conversation: your messages and, between them,
every tool call the agent made and what it returned. Nothing in storage is
written, deleted or changed. The agent may write a change for you to apply; the
app never runs it.

Version in this tree: **40.0.0**.

![A conversation in Storage Agent](docs/screenshot.png)

## What it does

- **Reads what the services return.** `call` runs one read-only operation of a
  bundled AWS SDK client: S3, S3 Control, STS, IAM, Organizations, KMS, Access
  Analyzer, CloudWatch, CloudTrail, Config, CloudFront, Backup, Security Hub,
  GuardDuty, SNS and SQS: the storage and the account around it. Any operation
  named Get, List, Head, Describe, Lookup, Search, Select, Simulate or BatchGet
  runs. The response is JSON, or the service's error code, HTTP status
  and message.
- **Answers questions over many objects.** `query` runs a read-only JavaScript
  script in a QuickJS sandbox. Its primitives include `call()` (object bodies
  come back whole), `read()`, `dataset()`, `inventory()`, `sql()`,
  `history()`, `memory()` and `render()`. It has no network, filesystem,
  process, timer or model access.
- **Analyzes data as it is.** `dataset()` imports an attached file, an object,
  or every object under a prefix (S3 server access logs, CSV, TSV, JSON lines,
  JSON, Parquet, plain lines) into a local SQLite table with every source
  column; `inventory()` imports an S3 Inventory report with the schema its
  manifest names. Nothing is dropped, masked or cut; the agent queries with
  SQL.
- **Extends its own tools.** `tool` saves a reusable method: a JSON Schema and a
  JavaScript body that runs in the same read-only sandbox. A method can be
  task-scoped or user-scoped, listed, run and deleted.
- **Remembers in JSON.** `memory` stores arbitrary JSON documents across tasks
  and app versions, with keys, tags, search, read-only SQL and task or user
  scope; each records the task that wrote it. The agent recalls; the app does
  not inject memory content into the prompt. `history()` reads what earlier
  tasks said.
- **Composes views.** `render` builds a declarative block tree: Markdown,
  tables, charts, trees, timelines, diffs, callouts, key-value rows and code.
  The document is data, never HTML or executable code.
- **Delegates.** `delegate` gives a self-contained investigation to a child
  agent with the same read-only tools, account scope, memory and task files;
  its steps show live in the parent's step, several run at once, and a
  question it would ask comes back to the parent.
- **Discovers the environment.** `discover` lists the bundled services and their
  read operations, the tools available, and their contracts.
- **Reads anything it was given, again.** Every result is kept; `more` reads
  any stretch of a result, an object body or an attached file, even after the
  conversation was compacted. An attached image is shown to a model that takes
  images.
- **Asks when it must.** `ask` puts a question in the conversation, with up to
  six options as buttons.
- **Shows what the agent did.** Each tool call is a step where it happened.
  Opening it shows the shaped result and exactly what the agent received.
  Provider reasoning appears as `Thought` when the provider returns it. The
  agent may link a call as `[1](#ev-<id>)`; the link opens that step. The app
  adds no report, verdict, summary or next-step prompt.
- **Uses the model you have.** OpenAI, Anthropic or an OpenAI-compatible
  endpoint; paste a key and the provider's models are fetched. Models running
  in Ollama or LM Studio are one click away.

## Shape

One window, one conversation per task, one composer. The task list is the only
navigation. Settings holds the model, accounts, memory, agent methods,
appearance and notifications.

```text
┌──────────────────────────── Electron ────────────────────────────┐
│ renderer (React, sandboxed)        main                          │
│ tasks · conversation ·      ⇄ IPC ⇄  pi-durable harness          │
│ composer                                ├ call · query · probe   │
│                                         ├ more · discover        │
│                                         ├ render · memory        │
│                                         ├ tool · delegate · ask  │
│                                         ├ s3/api (any read)      │
│                                         └ pi-ai → model          │
│                              one SQLite: pi_* + host tables      │
│                              memory.sqlite · tasks/<id>/ files   │
└──────────────────────────────────────────────────────────────────┘
```

- **Electron 45, TypeScript, React 19.** No sidecar, no HTTP server, no native
  addon.
- **pi-durable 1.4** owns the durable loop: storage, resume, steering, abort,
  compaction and tool tasks.
- **pi-ai 1.4** talks to OpenAI Responses, Anthropic Messages and
  OpenAI-compatible Chat Completions.
- **Accounts** use sealed access keys or an AWS profile. A profile resolves
  through the AWS SDK, including SSO, `credential_process` and assume-role.
- **One host SQLite database** through `node:sqlite`; pi's tables use the `pi_`
  prefix. Agent memory is a separate `memory.sqlite` so a memory query cannot
  reach host tables. Each imported dataset is its own SQLite file.
- **Scope** (`scope.buckets`) is enforced in the main process before any S3 or
  S3 Control call that names a bucket, and `ListBuckets` shows only scoped
  buckets. Focus in the composer is not scope.

## Development

```bash
npm ci
npm run dev              # Electron + Vite with HMR
npm run typecheck
npm run lint
npm test
npm run build
npm run budget           # first-paint renderer JavaScript under 500 KiB
npm run contrast         # secondary-text contrast
xvfb-run -a npm run perf # cold start to composer
npm run audit
npm run sbom
npm run dist:dir         # unpacked app under release/
```

End-to-end, screenshots and model evaluation:

```bash
xvfb-run -a node scripts/e2e.mjs
xvfb-run -a node scripts/e2e-audit.mjs
xvfb-run -a node scripts/shots.mjs && node scripts/visual.mjs
xvfb-run -a node scripts/eval.mjs --smoke
xvfb-run -a node scripts/bench.mjs --smoke
EVAL_PROVIDER=anthropic EVAL_MODEL=… EVAL_API_KEY=… \
  xvfb-run -a node scripts/eval.mjs
```

The E2E uses a fake S3 endpoint and a fake OpenAI-compatible model. Smoke runs
prove the harness runs; they are not a model-quality score. See
[docs/development.md](docs/development.md) and [docs/release.md](docs/release.md).

## Safety and limits

- No storage put, delete or mutate call exists. Only operations whose names
  say they read run, and the few reads that hand out credentials do not.
  Services whose reads return secrets or run compute (Lambda, EC2, Secrets
  Manager, SSM, ECR, DynamoDB) are not bundled.
- Secrets are sealed with Electron `safeStorage`, or a local AES-256-GCM key
  file when no OS keyring exists. A profile account stores a profile name,
  never a key. The renderer never receives a credential.
- Account ids never reach the model, the window, a log or SQLite. Every
  response and error passes through `scrub()`, which replaces every 12-digit
  number with `<account>`, whichever account it names, and redacts the account
  in ARNs. The agent writes `<account>` where the caller's id belongs and
  `call` fills it in.
- Tool output reaches the model inside `<untrusted-data>`, redacted. Tool
  status comes from structured details, never from result text.
- A denied or unsupported call comes back as the service's error. The call
  stays in the conversation; saying what could not be read is the agent's.
- Every read goes through the agent. Without a model the window asks for one;
  without an account it asks for one.
- The harness sets no round ceiling, call budget or fixed output cap: each
  model's output maximum is learned from its provider. **Stop** is yours, and
  stopping a task stops its child agents.
- An object body streams to the task folder, up to `max_bytes` (default 1 MiB,
  the agent's to raise; a `Range` reads any part). A 64 KiB preview is
  returned with a `ref`, and `more` reads any offset; a script gets the body
  whole.
- `probe` sends HEAD, GET or OPTIONS with any headers but credentials, so a
  CORS preflight can be tried; it never signs.
- Installers are signed and notarized only when every signing secret is
  configured. Without a model key, release notes carry a smoke result, not a
  model-quality claim.

Current behaviour, limits and IAM actions are in [docs/](docs/README.md).

## License

Apache-2.0.
