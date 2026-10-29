# Storage Agent

A local, read-only agent for S3-compatible object storage. You talk with the
agent; it reads the account with read-only tools and answers in its own words.
A **task** is one conversation: your messages and, between them, every tool
call the agent made and what it said. Nothing is written, deleted or changed in
storage. The agent may write a change for you to apply; the app never runs it.

Version in this tree: **37.0.0**.

![A conversation in Storage Agent](docs/screenshot.png)

## What it does

- **Reads what the services return.** `call` runs one read-only operation of
  any AWS SDK client the app bundles — S3, S3 Control, STS, IAM, Organizations,
  KMS, Access Analyzer, CloudWatch and CloudTrail — named Get, List, Head,
  Describe, Lookup, Search, Select or Simulate. It returns the service's
  response as JSON, or its error code, HTTP status and message. A custom-endpoint
  account answers every service at its own endpoint. The tools return data, not
  judgements: what is public, risky or missing is the agent's to decide and say.
- **Probes the endpoint.** `probe` sends one unsigned HEAD or GET to the
  account's endpoint and returns the addresses, status, headers, TLS
  certificate and timing. It marks nothing as passed or failed.
- **Answers open questions with code mode.** `query` runs a read-only
  JavaScript script in a QuickJS sandbox for questions over many objects or
  buckets: largest prefixes, data untouched for a year, versions piling up. Its
  primitives are `call()`, `dataset()` (an attached access log or inventory),
  `inventory()` (every file of a bucket's latest S3 Inventory) and `sql()` (one
  read-only SELECT over a dataset). It has no network, filesystem, process,
  timer or model access, and runs until it returns or you stop it.
- **Reads long results whole.** A result longer than 24,000 characters reaches
  the agent in pieces; `more` reads the rest.
- **Remembers in notes.** The agent writes `note`s, and can forget its own;
  every note is shown to it at the start of every turn, and you can forget any
  of them in Settings.
- **Asks when it must.** `ask` puts a question in the conversation, with up to
  six options as buttons.
- **Writes changes as text.** Asked for a fix, the agent writes the command or
  policy in its own Markdown. There is no Apply button, and the agent never
  says a change was made; only a later read shows it.
- **Shows what the agent did.** Each tool call is a step where it happened: a
  state mark, what it read, a note and its time. Opening it shows the shaped
  result and exactly what the agent received. A `call` or `probe` step opens
  as the response's JSON. Provider reasoning appears as `Thought`
  only when the provider returns it. The agent may link a call as
  `[1](#ev-<id>)`; the link opens that step in place. The app adds no report,
  verdict or summary of its own. Save Markdown, copy a task link, export JSON
  and save PDF live in one overflow menu. Tables copy as CSV.
- **Uses the model you have.** OpenAI, Anthropic or an OpenAI-compatible
  endpoint; paste a key and the provider's models are fetched. Context window
  and reasoning are inferred. Models already running in Ollama or LM Studio are
  one click away.

## Shape

One window, one conversation per task, one composer. The task list is the only
navigation. There is no storage browser, dashboard, side pane or second window.
Settings holds the model, accounts, memory, language, theme and notifications.

```text
┌──────────────────────────── Electron ────────────────────────────┐
│ renderer (React, sandboxed)        main                          │
│ tasks · conversation ·      ⇄ IPC ⇄  pi-durable harness          │
│ composer                                ├ call · query · probe   │
│                                         ├ more · note · ask      │
│                                         ├ s3/api (any read)      │
│                                         └ pi-ai → model          │
│                              one SQLite: pi_* + host tables      │
│                              tasks/<id>/uploads + datasets       │
└──────────────────────────────────────────────────────────────────┘
```

- **Electron 45 + TypeScript + React 19**. No sidecar, no HTTP server and no
  native addon build.
- **pi-durable 1.4** owns the durable loop: storage, resume, steering, abort,
  compaction and tool tasks. This app does not reimplement it.
- **pi-ai 1.4** provides model access for OpenAI Responses, Anthropic Messages
  and OpenAI-compatible Chat Completions.
- **Accounts** use sealed access keys or an AWS profile. A profile resolves
  through the AWS SDK, including SSO, `credential_process` and assume-role.
- **One SQLite database** through Node's built-in `node:sqlite`; pi's tables
  use the `pi_` prefix. Each imported dataset is a separate SQLite file.
- **Scope** (`scope.buckets`) is enforced in the main process by
  before any bucket call, and a bucket listing shows only the scoped buckets. Focus in the composer is not scope.

## Development

```bash
npm ci
npm run dev              # Electron + Vite with HMR
npm run typecheck
npm run lint
npm test
npm run build
npm run budget           # first-paint renderer bundle under 500 KiB
npm run contrast         # secondary-text contrast
xvfb-run -a npm run perf # cold start to composer
npm run audit
npm run sbom
npm run dist:dir         # unpacked app under release/
```

End-to-end, first-run, screenshot and model evaluation:

```bash
xvfb-run -a node scripts/e2e.mjs
xvfb-run -a node scripts/e2e-audit.mjs
xvfb-run -a node scripts/shots.mjs && node scripts/visual.mjs
xvfb-run -a node scripts/eval.mjs --smoke
xvfb-run -a node scripts/bench.mjs --smoke
EVAL_PROVIDER=anthropic EVAL_MODEL=… EVAL_API_KEY=… \
  xvfb-run -a node scripts/eval.mjs
```

The E2E uses a fake S3 endpoint and a fake OpenAI-compatible model. The smoke
runs prove the harness runs; they are not a model-quality score. See
[docs/development.md](docs/development.md) and [docs/release.md](docs/release.md).

## Safety and honest limits

- No storage put, delete or mutate call exists. A change the agent writes is
  text for the user to apply.
- Secrets are sealed with Electron `safeStorage`, or a local AES-256-GCM file
  when no OS keyring exists. Profile accounts store a profile name, never a key.
  The renderer receives masked metadata, never a credential.
- Only operations whose names say they read run; the few reads that hand out
  credentials (`sts:GetSessionToken` and the like) do not.
- Account ids never reach the model, the window, a log or SQLite: every
  response and error passes through `scrub()`, which replaces each 12-digit
  number with `<account>`, and `redact()` masks the account in any ARN. The
  agent writes `<account>` where the caller's id belongs and `call` fills it in.
- Tool output reaches the model inside `<untrusted-data>`, redacted. Tool
  status comes from `details.status`, never from result text.
- A denied or unsupported call comes back as the service's error code, HTTP
  status and message. The call stays in the conversation; saying what could not be read is
  the agent's. The app adds no coverage summary or verdict.
- Every read goes through the agent. Without a model the window says so and
  asks for one; without an account it asks for one.
- The harness sets no round ceiling, timeout, call budget or fixed output cap;
  how long to work is the agent's, and **Stop** is yours. Two defaults protect
  this machine and the agent can raise them: sandbox memory (`memory_mb`,
  1024 MB) and body bytes per read (`max_bytes`, 1 MiB). The window shows up
  to 10,000 query rows; the agent gets all of them.
- Release installers are signed and notarized only when all signing secrets are
  configured. Without a real `EVAL_API_KEY`, the release notes carry a smoke
  result rather than a model-quality claim.
- The rule engine and Issues, the survey, estate, change-plan and accept-risk
  tools, generated change plans, reading records, scheduled checks, **Check
  account** and demo storage were removed in 36.0. The `buckets`, `objects`,
  `object`, `config` and `account` tools and the 100-round ceiling were removed
  in 37.0; `call` replaces the five tools.

The exact current behavior, limits and IAM actions are in [docs/](docs/README.md);
the changelog and release notes are history, not current documentation.

## License

Apache-2.0.
