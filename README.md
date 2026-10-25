# Storage Agent

A local, read-only agent for S3-compatible object storage. You ask a question;
the agent reads the account, remembers what it saw, and projects the result as a
**brief** grounded in tool results. A **task** is the window's object, and the
**estate** is the agent's memory. Nothing is written, deleted or changed in
storage, and the app never applies a fix.

Current version: **25.0.0**. The latest published release is **24.0.0**; this
checkout has not been tagged or published.

![A brief in Storage Agent](docs/screenshot.png)

## What it does

- **Survey an account.** Reads bucket policy, ACL, public access block, TLS
  policy, ownership, CORS, logging, encryption and lifecycle, plus the
  account-wide public access block and, on AWS, CloudWatch capacity. A survey
  reads up to 5,000 buckets, longest-unread first, and stops before its 300-second
  timeout rather than pretending it finished. Twelve deterministic rules turn
  those readings into current findings; a blind read leaves its rule undecided.
- **Check account without a model or an API key.** Home can survey and read
  access evidence, then write one deterministic `sa.audit` entry. The task opens
  immediately and progress is visible. On a first run, demo storage is an
  explicit **Try with demo storage** choice; the app never adds it silently.
- **Read access evidence.** Bucket policy and ACL grants are read locally; IAM
  users, groups, managed and inline policies, permission boundaries and role
  trust are read with paginated account authorization details; SCPs, KMS key
  policy and Access Analyzer are read when available. Identity grants are
  intersected with bucket-policy Denies and, where present, SCPs and
  permission boundaries. Policy and ACL rows are still grant evidence, not one
  merged authorization verdict; conditions, unread sources and truncation are
  shown in the coverage line.
- **Explain changes.** A survey compares the reading with the last remembered
  posture. On AWS it asks CloudTrail who changed the bucket over a stated
  90-day window. A denied lookup leaves the actor unknown, never "nobody".
- **Ask what happened.** `estate(history: true)` reads remembered Issue events
  and posture changes, optionally narrowed by bucket, rule or date. It is the
  same estate and the same Data section, not a new transcript or tool.
- **Know when the reading is closed.** The scope line says `Reads complete` or
  `Reads open: n · m blocked`, and the Not read section names failed, blind,
  partial and pending reads. A narrowed re-read never substitutes for account
  coverage.
- **Answer open questions with code mode.** `query` runs a short read-only
  script in a QuickJS sandbox for questions over many objects or buckets:
  largest prefixes, data untouched for two years, versions piling up. There is
  no network, filesystem, process, timer or model access. The rows become the
  page and the script stays as evidence.
- **Import logs and inventories.** Attach an access log or S3 Inventory, then
  use `dataset`, `aggregate`, `inventory` or `principal`. A full Inventory can
  be imported into a local dataset; raw rows never reach the model.
- **Generate fixes as text.** The agent produces AWS CLI, Terraform and API
  document text with an impact preview built from what the estate remembers.
  There is no Apply button.
- **Re-verify without a model.** Re-read the buckets the task touched and report
  which conclusions changed, which stayed open and which could not be re-read.
- **Keep the evidence.** The brief has a scope line, findings grouped by bucket,
  changes, open questions, fixes, one data section and a checks receipt. Copy,
  save Markdown, check again, re-verify, copy a task link, export the evidence
  pack and save PDF live behind a visible overflow menu. Tables copy as CSV.
- **Use the model you have.** Pick OpenAI, Anthropic or an OpenAI-compatible
  endpoint; paste a key and the provider's models are fetched. Context window
  and reasoning effort are inferred. Models already running in Ollama or LM
  Studio are one click away.

## Shape

One window, one brief, one composer. The task list is the only navigation.
There is no storage browser, dashboard, side pane, chat transcript or second
window. Settings holds the model, accounts, memory, language, theme and
notifications.

```text
┌──────────────────────────── Electron ────────────────────────────┐
│ renderer (React, sandboxed)        main                          │
│ tasks · brief · composer    ⇄ IPC ⇄  pi-durable harness          │
│                                         ├ 10 read-only tools     │
│                                         ├ estate (rules/issues)  │
│                                         ├ s3 (readers/access)    │
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
xvfb-run -a npm run perf # cold start to composer
npm run audit
npm run sbom
npm run dist:dir         # unpacked app under release/
```

End-to-end, first-run, screenshot and real-model evaluation:

```bash
xvfb-run -a node scripts/e2e.mjs
xvfb-run -a node scripts/e2e-audit.mjs
xvfb-run -a node scripts/shots.mjs && node scripts/visual.mjs
xvfb-run -a node scripts/eval.mjs --smoke
EVAL_PROVIDER=anthropic EVAL_MODEL=… EVAL_API_KEY=… \
  xvfb-run -a node scripts/eval.mjs
```

The normal E2E uses a fake S3 endpoint and a fake OpenAI-compatible model. The
smoke eval proves the harness runs; it is not a model-quality score. See
[docs/release.md](docs/release.md) for the release path and its signed/smoke
fallbacks.

## Safety and honest limits

- No storage put, delete or mutate call exists. Fix commands are text for the
  user to apply.
- Secrets are sealed with Electron `safeStorage`, or a local AES-256-GCM file
  when no OS keyring exists. Profile accounts store a profile name, never a key.
  The renderer receives masked metadata, never a credential.
- Tool output reaches the model inside `<untrusted-data>` and is bounded and
  redacted. Tool status comes from `details.status`, never from result text.
- A denied or unsupported read is a blind spot. It is never converted into a
  clean result. The scope line and **Not read** section say what is missing.
- Access analysis is evidence, not a complete authorization decision. Policy
  and ACL grants are not merged with every identity, SCP and condition into a
  single yes/no; service principals, federated identities and some external
  policies remain out of scope. Coverage is stated instead of implied.
- A survey is capped at 5,000 buckets and its time budget. CloudTrail covers 90
  days and attributes at most six changed buckets per survey; re-verification
  replays at most 50 buckets per account and can skip or truncate. Inventory
  full imports are bounded by files, bytes and 2,000,000 rows. `query` has
  explicit call, listing, time, memory and row budgets.
- Release installers are signed and notarized only when all signing secrets are
  configured. Without a real `EVAL_API_KEY`, the release notes carry a smoke
  result rather than a model-quality claim.

The exact current behavior, limits and IAM actions are in [docs/](docs/README.md);
the changelog and release notes are history, not current documentation.

## License

Apache-2.0.
