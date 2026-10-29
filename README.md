# Storage Agent

A local, read-only agent for S3-compatible object storage and the cloud around
it. You talk with the agent; it decides what to read, how to investigate and
what to say. A **task** is one conversation: your messages and, between them,
every tool call the agent made and what it returned. Nothing in storage is
written, deleted or changed. The agent may write a change for you to apply; the
app never runs it.

Version in this tree: **38.0.0**.

![A conversation in Storage Agent](docs/screenshot.png)

## What it does

- **Reads what the services return.** `call` runs one read-only operation of a
  bundled AWS SDK client: S3, S3 Control, STS, IAM, Organizations, KMS, Access
  Analyzer, CloudWatch, CloudTrail, EC2, Lambda, DynamoDB, RDS, CloudFront,
  Route 53, Config, Security Hub, GuardDuty, ECR, SNS, SQS, Secrets Manager,
  SSM, Service Quotas, Support, Backup and Cost Explorer. Any operation named
  Get, List, Head, Describe, Lookup, Search, Select, Simulate, BatchGet, Query
  or Scan runs. The response is JSON, or the service's error code, HTTP status
  and message.
- **Answers questions over many objects.** `query` runs a read-only JavaScript
  script in a QuickJS sandbox. Its primitives include `call()`, `dataset()`,
  `inventory()`, `memory()`, `render()` and `sql()`. It has no network,
  filesystem, process, timer or model access.
- **Extends its own tools.** `tool` saves a reusable method: a JSON Schema and a
  JavaScript body that runs in the same read-only sandbox. A method can be
  task-scoped or user-scoped, listed, run and deleted.
- **Remembers in JSON.** `memory` stores arbitrary JSON documents across tasks,
  with keys, tags, search, read-only SQL and task or user scope. The agent
  recalls; the app does not inject memory content into the prompt.
- **Composes views.** `render` builds a declarative block tree: Markdown,
  tables, charts, trees, timelines, diffs, callouts, key-value rows and code.
  The document is data, never HTML or executable code.
- **Delegates.** `delegate` gives a self-contained investigation to a child
  agent with the same read-only tools, account scope and memory, and returns its
  answer in the parent conversation.
- **Discovers the environment.** `discover` lists the bundled services and their
  read operations, the tools available, and their contracts.
- **Reads long results whole.** A result longer than 24,000 characters reaches
  the agent in pieces; `more` reads the rest. An object body streams to the
  task folder and is previewed; `more` can read any offset of the stored body.
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
  Secret-store reads (Secrets Manager and SSM parameters) are refused.
- Secrets are sealed with Electron `safeStorage`, or a local AES-256-GCM key
  file when no OS keyring exists. A profile account stores a profile name,
  never a key. The renderer never receives a credential.
- Account ids never reach the model, the window, a log or SQLite. Every
  response and error passes through `scrub()`, which replaces the caller's
  actual account id and account fields (such as a policy principal) with
  `<account>` and redacts the account in ARNs. Other 12-digit data is not
  rewritten. The agent writes `<account>` where the
  caller's id belongs and `call` fills it in.
- Tool output reaches the model inside `<untrusted-data>`, redacted. Tool
  status comes from structured details, never from result text.
- A denied or unsupported call comes back as the service's error. The call
  stays in the conversation; saying what could not be read is the agent's.
- Every read goes through the agent. Without a model the window asks for one;
  without an account it asks for one.
- The harness sets no round ceiling, call budget or fixed output cap; **Stop**
  is yours. The model's output budget is a bounded default of
  `min(32,000, context window)` tokens.
- An object body streams to the task folder; `max_bytes` can stop it earlier.
  A 64 KiB preview is returned with a `ref`, and `more` reads any offset.
- Installers are signed and notarized only when every signing secret is
  configured. Without a model key, release notes carry a smoke result, not a
  model-quality claim.

Current behaviour, limits and IAM actions are in [docs/](docs/README.md).

## License

Apache-2.0.
