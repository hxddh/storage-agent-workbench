# Storage Agent

A local, read-only agent for S3-compatible object storage. You talk with the
agent; it reads the account with read-only tools and answers in its own words.
A **task** is one conversation: your messages and, between them, every tool
call the agent made and what it said. Nothing is written, deleted or changed in
storage. The agent may write a change for you to apply; the app never runs it.

Version in this tree: **36.0.0**.

![A conversation in Storage Agent](docs/screenshot.png)

## What it does

- **Reads what the storage APIs return.** `config` reads one bucket's
  configuration section by section — location, policy, policy status, public
  access block, ACL, ownership, encryption, versioning, object lock, lifecycle,
  replication, CORS, website, logging, notification, inventory, tagging — each
  as `{ status, value }` or `{ status, error }`. On AWS, `account` reads the
  account-wide public access block, IAM authorization details, SCPs, a KMS key
  policy, Access Analyzer findings, CloudWatch storage metrics and CloudTrail
  events, the same way. The tools return data, not judgements: what is public,
  risky or missing is the agent's to decide and say.
- **Browses and checks.** `buckets`, `objects` (keys, versions or incomplete
  uploads, a page at a time) and `object` (metadata, tags, ACL, a bounded text
  preview). `probe` checks an endpoint's reach, TLS, latency, bucket region and
  addressing.
- **Answers open questions with code mode.** `query` runs a short read-only
  script in a QuickJS sandbox for questions over many objects or buckets:
  largest prefixes, data untouched for a year, versions piling up. It has no
  network, filesystem, process, timer or model access. The rows and the script
  open under the query's step.
- **Reads logs and inventories.** Inside `query`, `inventory` reads a bucket's
  latest S3 Inventory manifest, or imports every manifest file into a local
  dataset; `dataset` imports an attached access log or inventory; `aggregate`
  and `rows` read it (redacted, client IPs masked). There is no SQL.
- **Remembers in notes.** The agent writes `note`s; they are shown to it at the
  start of every turn, and you can forget them in Settings.
- **Asks when it must.** `ask` puts a question in the conversation, with up to
  six options as buttons.
- **Writes changes as text.** Asked for a fix, the agent writes the command or
  policy in its own Markdown. There is no Apply button, and the agent never
  says a change was made; only a later read shows it.
- **Shows what the agent did.** Each tool call is a step where it happened: a
  state mark, what it read, a note and its time. Opening it shows the shaped
  result and exactly what the agent received. A `config` read opens as its
  sections with their status and JSON. Provider reasoning appears as `Thought`
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
│ composer                                ├ 7 read tools           │
│                                         ├ note                   │
│                                         ├ ask                    │
│                                         ├ s3/raw (readers)       │
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
  `assertInScope` before any bucket read. Focus in the composer is not scope.

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
- Account ids never reach the model, the window, a log or SQLite: reads that
  carry them pass through `scrub()`, which replaces each 12-digit number with
  `<account>`, and `redact()` masks the account in any ARN.
- Tool output reaches the model inside `<untrusted-data>` and is bounded and
  redacted. Tool status comes from `details.status`, never from result text.
- A denied or unsupported read comes back as that status with the provider's
  error. The call stays in the conversation; saying what could not be read is
  the agent's. The app adds no coverage summary or verdict.
- Every read goes through the agent. Without a model the window says so and
  asks for one; without an account it asks for one.
- `query` runs under call, listing, time and memory budgets. Inventory full
  imports are bounded by files, bytes and 2,000,000 rows.
- Release installers are signed and notarized only when all signing secrets are
  configured. Without a real `EVAL_API_KEY`, the release notes carry a smoke
  result rather than a model-quality claim.
- The rule engine and Issues, the survey, estate, change-plan and accept-risk
  tools, generated change plans, reading records, scheduled checks, **Check
  account** and demo storage were removed in 36.0.

The exact current behavior, limits and IAM actions are in [docs/](docs/README.md);
the changelog and release notes are history, not current documentation.

## License

Apache-2.0.
