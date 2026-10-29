# Storage Agent

A local, read-only agent for S3-compatible object storage. You talk with the
agent; it reads the account with read-only tools and answers in its own words.
A **task** is one conversation: your messages and, between them, every tool
call the agent made and what it said. Nothing in storage is written, deleted or
changed. The agent may write a change for you to apply; the app never runs it.

Version in this tree: **37.0.0**.

![A conversation in Storage Agent](docs/screenshot.png)

## What it does

- **Reads what the services return.** `call` runs one read-only operation of
  an AWS SDK client the app bundles (S3, S3 Control, STS, IAM, Organizations,
  KMS, Access Analyzer, CloudWatch, CloudTrail): any operation named Get, List,
  Head, Describe, Lookup, Search, Select or Simulate. It returns the response
  as JSON, or the error code, HTTP status and message. A custom-endpoint
  account sends every service to its own endpoint. The tools return data;
  what is public, risky or missing is the agent's to decide and say.
- **Probes the endpoint.** `probe` sends one unsigned HEAD or GET to the
  account's endpoint and returns the addresses, status, headers, TLS
  certificate and timing.
- **Answers questions over many objects.** `query` runs a read-only JavaScript
  script in a QuickJS sandbox. Its primitives are `call()`, `dataset()` (an
  attached access log or inventory), `inventory()` (a bucket's latest S3
  Inventory) and `sql()` (one read-only SELECT over a dataset). It has no
  network, filesystem, process, timer or model access.
- **Reads long results whole.** A result longer than 24,000 characters reaches
  the agent in pieces; `more` reads the rest.
- **Remembers in notes.** The agent writes `note`s and can forget its own.
  Every note is in the prompt of every turn; you can forget any note in
  Settings.
- **Asks when it must.** `ask` puts a question in the conversation, with up to
  six options as buttons.
- **Writes changes as text.** Asked for a fix, the agent writes the command or
  policy in its own Markdown. There is no Apply button.
- **Shows what the agent did.** Each tool call is a step where it happened.
  Opening it shows the result and exactly what the agent received. Provider
  reasoning appears as `Thought` when the provider returns it. The agent may
  link a call as `[1](#ev-<id>)`; the link opens that step. The app adds no
  report, verdict or summary. One overflow menu saves Markdown, copies a task
  link, exports JSON and saves PDF.
- **Uses the model you have.** OpenAI, Anthropic or an OpenAI-compatible
  endpoint; paste a key and the provider's models are fetched. Models running
  in Ollama or LM Studio are one click away.

## Shape

One window, one conversation per task, one composer. The task list is the only
navigation. Settings holds the model, accounts, memory, language, theme and
notifications.

```text
┌──────────────────────────── Electron ────────────────────────────┐
│ renderer (React, sandboxed)        main                          │
│ tasks · conversation ·      ⇄ IPC ⇄  pi-durable harness          │
│ composer                                ├ call · query · probe   │
│                                         ├ more · note · ask      │
│                                         ├ s3/api (any read)      │
│                                         └ pi-ai → model          │
│                              one SQLite: pi_* + host tables      │
│                              tasks/<id>/ files and datasets      │
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
- **One SQLite database** through `node:sqlite`; pi's tables use the `pi_`
  prefix. Each imported dataset is its own SQLite file.
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
- Secrets are sealed with Electron `safeStorage`, or a local AES-256-GCM key
  file when no OS keyring exists. A profile account stores a profile name,
  never a key. The renderer never receives a credential.
- Account ids never reach the model, the window, a log or SQLite. Every
  response and error passes through `scrub()`, which replaces each 12-digit
  number with `<account>`. The agent writes `<account>` where the caller's id
  belongs and `call` fills it in.
- Tool output reaches the model inside `<untrusted-data>`, redacted. Tool
  status comes from structured details, never from result text.
- A denied or unsupported call comes back as the service's error. The call
  stays in the conversation; saying what could not be read is the agent's.
- Every read goes through the agent. Without a model the window asks for one;
  without an account it asks for one.
- The harness sets no round ceiling, call budget or fixed output cap; **Stop**
  is yours. Two defaults protect this machine, and the agent can raise them:
  sandbox memory (1,024 MB) and body bytes per read (1 MiB).
- Installers are signed and notarized only when every signing secret is
  configured. Without a model key, release notes carry a smoke result, not a
  model-quality claim.

Current behaviour, limits and IAM actions are in [docs/](docs/README.md).

## License

Apache-2.0.
