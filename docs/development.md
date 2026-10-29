# Development

## Requirements

- Node.js 24 or newer (`engines` requires `>=24`).
- npm 10+.
- Linux desktop builds need the usual Electron runtime libraries; CI uses
  `ubuntu-latest`.
- `xvfb` is required for the Electron tests on a headless Linux machine.
- Optional: Python 3.12 and `moto[server]==5.2.4` for the AWS compatibility
  test; Ollama or LM Studio for local models.

## Commands

```bash
npm ci
npm run dev              # Electron + Vite with HMR
npm run typecheck        # tsconfig.node.json + tsconfig.web.json
npm run lint             # Biome
npm test                 # Vitest
npm run build            # out/{main,preload,renderer}
npm run budget           # initial renderer JavaScript under 500 KiB
xvfb-run -a npm run perf # cold start to composer under 1 s
npm run audit            # production dependency audit
npm run sbom             # CycloneDX SBOM
npm run dist:dir         # unpacked app in release/
npm run dist             # installers for the current OS
```

The package also exposes direct aliases: `npm run e2e`, `npm run e2e:audit`,
`npm run eval`, `npm run visual`.

## Tests

`npm test` is the fast suite. It covers policy evaluation and exposure, the
twelve rules and tri-state decisions, the account rule, TLS policy detection,
Issue lifecycle (opened, resolved, gone, accepted, recurred), schema migrations,
scope and the tool floor, code mode (sandbox, budgets, timeout, import), demo
storage, generated change plans and impact, log normalization and IP masking,
CSV/Parquet import and the aggregate whitelist, the search index, entry → UI
projection (including 35.x entries and budget-blocked calls), the conversation
projection (order, steers, the live slot, citations, what each call returned, Markdown),
the round budget rebuilt from durable entries, migrations 15 and 16, redaction,
provider capabilities, posture diffs, permission diagnosis, model windows,
access evaluation and reading records. `Conversation.test.tsx` and
`Composer.test.tsx` run in jsdom; the rest use Node.

### Domain and compatibility

- `src/main/domain.test.ts` runs the real AWS SDK and the real tools over HTTP
  against `scripts/fake-s3.mjs` profiles: AWS, an S3-compatible store without
  policy status, a denied ACL, a condition-narrowed policy, CORS `*`, versioning
  and the demo account. It uses a real SQLite estate.
- `src/main/compat.test.ts` runs against moto, an independent AWS emulator, for
  S3 exposure, the account-wide block and access reads where moto supports them.
  It runs only with `STORAGE_AGENT_AWS_ENDPOINT`:

  ```bash
  pip install 'moto[server]==5.2.4'
  moto_server -p 5055 &
  STORAGE_AGENT_AWS_ENDPOINT=http://127.0.0.1:5055 \
    npx vitest run src/main/compat.test.ts
  ```

### Real window

- `scripts/e2e.mjs` builds the app and drives the real Electron window against
  `scripts/fake-s3.mjs` (delayed so a running check is observable) and
  `scripts/fake-model.mjs` and drives it as a conversation. It covers model
  setup and test, Check account as a message (and that the 35.x scaffolding
  `Earlier in this task`, `Not checked` and `Worked for` is gone), a follow-up
  in the same thread, a citation opening its call, axe (serious/critical
  violations fail), `@` focus, a clarifying question answered by an option,
  access rows, accepting a risk through the confirmation card, applying a fix
  outside the app and the agent's re-read, a generated change plan,
  stop/continue, search (opening an agent text), code-mode rows and the demo
  account.
- `scripts/e2e-audit.mjs` starts with no model and no account, checks that the
  composer is disabled, chooses demo storage explicitly, and checks that this
  only adds the account: no task, no conversation, no **Check account**, and
  **Set up a model** is offered. It captures the no-model state.
- `scripts/shots.mjs` captures Home, Settings, the conversation (task, citation
  open, tool detail, follow-up, estate, history, live, change plan, risk
  confirmation), dark-mode, compact and Chinese states under
  `.amp/in/artifacts`.
- `scripts/visual.mjs` compares those captures to `visual/baseline`. It rejects
  a global pixel change above 5% and any 64px tile with a large local change,
  so a missing control is not hidden by a large unchanged window.
- `scripts/perf.mjs` launches three times and fails when the median time to a
  visible composer exceeds 1,000 ms.
- `scripts/budget.mjs` excludes the lazily loaded `Settings`, `Conversation`
  and `Markdown` chunks and fails when the remaining renderer JavaScript
  exceeds 500 KiB.

### Evaluation

`scripts/eval.mjs` has 28 scenarios. It scores findings (the Issue rows in the
conversation's survey steps), answers that name what was found and what could
not be read, blind-spot honesty, memory-first and estate-history behavior,
verify-after-fix, code mode, access questions,
prompt-injection-shaped object names and call counts. The script runs the real
window against fake S3.

`scripts/bench.mjs` has 14 agent-behavior scenarios scored on the conversation:
`public-account`, `blind-acl`, `memory-first`, `clarify`, `fix-plan`, `query`,
`unknown-bucket`, `citation-validity`, `stop-continue`, `steer`,
`model-switch`, `retry-after-steer`, `follow-up` and `accept-risk`. `--smoke`
runs them with the fake model.

```bash
xvfb-run -a node scripts/eval.mjs --smoke
EVAL_PROVIDER=anthropic EVAL_MODEL=... EVAL_API_KEY=... \
  xvfb-run -a node scripts/eval.mjs
```

`--smoke` runs only the `public-aws` scenario with the fake model. It proves the
harness and scoring plumbing run; it is not a quality result. A real run exits
non-zero when a must-pass check fails and writes
`.amp/in/artifacts/eval-report.md` and `.json`. The report names the model and
never includes the key.

## Packaging

`electron-builder` reads the `build` block in `package.json`:

- macOS: `.dmg` and `.zip`, x64 and arm64, notarization when secrets exist.
- Windows: NSIS `.exe`.
- Linux: AppImage and `.deb`.
- Update feeds: `latest.yml`, `latest-mac.yml`, `latest-linux.yml`.
- SBOM: `sbom.json`.

There are no native Node addons to rebuild; QuickJS is shipped as WebAssembly
and unpacked from the asar. The release workflow, its smoke/real evaluation
fallback and its signing fallback are described in [release.md](release.md). A
tagged release builds all three platforms or publishes nothing.

## Release work

1. Run the local gates you intend to claim: typecheck, lint, unit tests, build,
   budget, E2E, audit E2E, shots/visual, and the relevant eval.
2. Bump `package.json` and `package-lock.json`.
3. Commit, tag the commit, and push the tag. Do not move a published tag.
4. Watch the Release workflow. With `EVAL_API_KEY` it runs two model
   evaluations; without it, it records a smoke result. With signing secrets it
   signs and notarizes; without them, it builds ad-hoc/unsigned packages and
   says so.
5. Install the previous release and verify the update path manually when the
   change affects packaging or `electron-updater`.

## Known gaps

- Real-model evaluation and signed/notarized installers require external
  credentials. The repository can run the smoke evaluation and unsigned
  packaging without them, but must not present that as a quality or signing
  claim.
- There is no automated native-dialog test for the file picker or save dialog.
- Search indexes titles, user messages and the agent's text only; it does not
  index tool results, attachments or every object name. FTS5 trigram ranks longer
  queries; short CJK queries use LIKE. It returns at most 20 hits.
- The sidebar shows the 500 most recently updated tasks; Settings lists the 100
  most recent notes. Older rows remain in SQLite but are not shown.
- Removing an account deletes its provider/bucket notes; `issue_events` keep
  their historical rows with the Issue. See [data-model.md](data-model.md).
- Access analysis is evidence with coverage, not a complete IAM authorization
  proof.
- There is no import from an earlier version of the app.
- The E2E axe gate covers serious and critical violations; `scripts/contrast.mjs`
  guards the secondary-text token pairs. It is not a full contrast certification.
