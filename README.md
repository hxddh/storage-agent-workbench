# Storage Agent

A local agent for object storage. You ask a question about your S3-compatible
accounts; it surveys them read-only, remembers what it saw, and answers with the
data in front of you. It never writes, deletes or changes anything in storage.

![Storage Agent](docs/screenshot.png)

## What it does

- Surveys an account and records each bucket's exposure, encryption, lifecycle
  and public-access posture.
- Opens deterministic Issues from seven rules: public exposure, wildcard
  principal, CORS `*`, no default encryption, missing public-access block,
  no incomplete-multipart cleanup, noncurrent versions never expiring.
- Reviews one bucket's configuration and reports findings, or says a provider
  does not implement the API instead of pretending it is clean.
- Lists objects, versions and incomplete uploads; inspects one object's metadata,
  tags, ACL and a bounded text preview.
- Generates fixes as text — AWS CLI, Terraform and the API document — with an
  impact preview built only from what the estate already knows.
- Analyzes an attached access log or object inventory (CSV, TSV, JSONL, Parquet)
  and answers whitelisted aggregates. Raw rows never reach the model.
- Watches an account on a schedule and opens a task when something changed.

## Shape

One window, one document, one composer. The task list is the only navigation.
There is no storage page, no bucket browser, no dashboard and no settings
wizard: the agent resolves storage from the request, and Settings holds the
model and the accounts.

```text
┌──────────────────────────── Electron ────────────────────────────┐
│  renderer (React)                    main                        │
│  tasks · document · composer  ⇄ IPC ⇄  pi-durable harness        │
│                                        ├ 10 read-only tools      │
│                                        ├ estate (rules/issues)   │
│                                        └ pi-ai → model           │
│                              one SQLite: pi_* + host tables      │
└──────────────────────────────────────────────────────────────────┘
```

- **Electron 45 + TypeScript + React 19**, no sidecar, no localhost HTTP.
- **pi-durable 1.4** for the durable agent loop: storage, resume, steering,
  abort, compaction and tool tasks.
- **pi-ai 1.4** for model access: OpenAI, Anthropic and any OpenAI-compatible
  endpoint (Ollama, LM Studio, vLLM, OpenRouter).
- **One SQLite database** through Node's built-in `node:sqlite`; pi's tables are
  prefixed `pi_`. Each imported dataset is a separate SQLite file.
- **No native addons.** Nothing to rebuild, nothing to sign beyond the app.

## Development

```bash
npm ci
npm run dev          # Electron + Vite with HMR
npm run typecheck
npm run lint
npm test
npm run build
npm run dist:dir     # unpacked app under release/
```

End-to-end against a fake S3 and a fake OpenAI-compatible model:

```bash
xvfb-run -a node scripts/e2e.mjs
xvfb-run -a node scripts/shots.mjs   # screenshots under .amp/in/artifacts
```

## Security

Secrets live in the OS keychain through Electron `safeStorage`, or — when no
keyring is available — in a local AES-256-GCM file with a 0600 key. SQLite holds
only ciphertext. Every tool is read-only. A provider's bucket scope is enforced
server-side before any call. Tool output reaches the model inside an
`<untrusted-data>` envelope, and credentials are redacted before anything is
stored, shown or sent. See [docs/security.md](docs/security.md).

## Deliberate omissions

No message editing or version trees, no Evidence side pane, no report or trace
export, no MCP bridge, no user skills, no standing instructions, no S3 log
download (attach the log instead), and no import of the previous app's data.

License: Apache-2.0.
