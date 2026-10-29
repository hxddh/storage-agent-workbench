# Development

## Requirements

- Node.js 24 or newer (`engines` requires `>=24`) and npm 10+.
- Linux desktop builds need the usual Electron runtime libraries; CI uses
  `ubuntu-latest`.
- `xvfb` for the Electron scripts on a headless Linux machine.
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
npm run budget           # first-paint renderer JavaScript under 500 KiB
npm run contrast         # secondary-text token contrast
xvfb-run -a npm run perf # cold start to composer under 1 s
npm run audit            # production dependency audit
npm run sbom             # CycloneDX SBOM
npm run dist:dir         # unpacked app in release/
npm run dist             # installers for the current OS
```

Script aliases: `npm run e2e`, `npm run e2e:audit`, `npm run eval`,
`npm run bench`, `npm run visual`, `npm run perf`.

## Tests

`npm test` is the fast suite. It covers:

- `call` over a fake S3: any read runs and returns what the service answered,
  policy documents parsed, a failed call's error code and HTTP status, a body
  read up to the bytes asked for, anything not a read and any bucket outside
  scope refused before a request, account ids scrubbed, a stopped call
  reported as stopped;
- a long result sent as its first piece and read on with `more`;
- memory documents written without secrets, task and user scope, read-only
  SQL over the separate memory file, and forgetting one;
- agent-authored methods: schema validation, sandbox limits, task and user
  scope, a method returning rows or a view, and deletion;
- `render` documents: valid blocks, nesting, limits and rejection of invalid
  or oversized input;
- `delegate`: a child gets the same scope, returns its answer, and is purged
  with the task;
- `discover`, `ask` with and without options;
- code mode: the sandbox has no network, filesystem or process, a script
  pages through every object, scope holds inside a script, a script runs until
  stopped, SQL over an attached log only reads;
- log normalization, IP masking, CSV and Parquet import, inventory import;
- the schema: created on a new file, migrated from 17 in place, and started
  over from an older incompatible layout with pi tables included;
- the search index (CJK substrings, FTS ranking, `%` and `_` as text);
- the entry projection, the live projection and the conversation thread
  (order, steers, the live slot, citations, what each call returned, the
  Markdown transcript, a reply cut at the output limit);
- the prompt (the hard rules, no hook that blocks a call, the accounts and the
  memory count in the digest, no injected memory content), the output budget,
  redaction, AWS profiles, the model catalog and the localized dictionaries.

`Conversation.test.tsx` and `Composer.test.tsx` run in jsdom; the rest run in
Node.

### Domain and compatibility

- `src/main/domain.test.ts` runs the real AWS SDK and the real tools over HTTP
  against `scripts/fake-s3.mjs`, whose responder is `scripts/fake-s3-core.mjs`:
  bucket profiles that answer as real providers do, including their 403s and
  501s. It uses a real SQLite database.
- `src/main/compat.test.ts` runs `call` against moto, an independent AWS
  emulator, as a custom-endpoint account: what AWS says about exposure, the
  account-wide public access block, account-level IAM, a KMS key policy and
  CloudTrail events, with the account id never passed on. It runs only with
  `STORAGE_AGENT_AWS_ENDPOINT`:

  ```bash
  pip install 'moto[server]==5.2.4'
  moto_server -p 5055 &
  STORAGE_AGENT_AWS_ENDPOINT=http://127.0.0.1:5055 \
    npx vitest run src/main/compat.test.ts
  ```

### Real window

- `scripts/e2e.mjs` builds the app and drives the real Electron window against
  `scripts/fake-s3.mjs` (delayed so running work is observable) and
  `scripts/fake-model.mjs`, a fake OpenAI-compatible endpoint that lists the
  buckets with `call`, reads what it needs of each, and answers from what came
  back. It covers model setup from the fetched list, adding an account, axe on
  Settings, Home and the conversation (serious or critical violations fail),
  Home offering nothing that starts a read, an answer built from `Read` steps,
  a step showing the response and exactly what the agent received, a follow-up
  in the same thread, `@` focus, a clarifying question answered by an option,
  a fix applied outside the app and the agent's re-read, a change written as
  the agent's text, Stop and Continue (the reply lands after the divider),
  search opening an agent text, and code-mode rows and script.
- `scripts/e2e-audit.mjs` starts with no model and no account and checks that
  the composer is disabled, that **Set up a model** and **Add an account** are
  offered, that nothing offers to run a read, and that no account, task or
  conversation appears on its own.
- `scripts/shots.mjs` captures Home, Settings and the conversation in light,
  dark, compact and Chinese states under `.amp/in/artifacts`.
- `scripts/visual.mjs` compares those captures to `visual/baseline`:
  `01-home-light`, `01b-home-configured-light`, `02-settings-light`,
  `02a-settings-model`, `02b-settings-appearance`, `02c-settings-dark`,
  `02d-settings-account-form`, `03-task-light`, `04-follow-up-light`,
  `06-task-dark`, `07-home-dark`, `08-live-light`, `09-task-compact`,
  `10-sidebar-compact`, `11-home-compact`, `12-settings-compact`,
  `13-memory-light`, `14-change-light`, `20-home-zh`, `21-settings-error-zh`,
  `23-tool-detail`, `24-citation-open`, `25-render-light`,
  `26-agent-tool-light`, `27-delegate-light`, `02e-settings-methods` and `02f-settings-memory`. It
  fails on a missing capture, a size change, a global pixel change above 5%,
  or any 64px tile that is mostly changed, so a missing control is not hidden
  by a large unchanged window. `--update` writes a new baseline for every
  capture.
- `scripts/perf.mjs` launches three times and fails when the median time to a
  visible composer exceeds 1,000 ms.
- `scripts/budget.mjs` leaves out the lazy `Settings`, `Conversation` and
  `Markdown` chunks and fails when the remaining renderer JavaScript exceeds
  500 KiB.

### Evaluation

`scripts/eval.mjs` has 28 scenarios. A model drives the real window against
fake S3 profiles whose truth is known, and each run is scored on the agent's
answer: the right buckets called public and no others, what it could not read
said and no claim of a clean account, the expected conditions or prefixes
named (the largest prefix computed from the fake storage's own objects), a fix
given as text, and no claimed write. Calls are reported, not scored: a 404
such as `NoSuchBucketPolicy` is a normal answer, and how much to read is the
agent's. Scenarios include an S3-compatible store, a denied ACL, a
condition-narrowed policy, a fix applied mid-task, memory in a new task, large
and stale prefixes, and a prompt-injection-shaped object key.

`scripts/bench.mjs` has 13 agent-behaviour scenarios scored on the
conversation: `public-account`, `blind-acl`, `memory`, `clarify`, `fix`,
`query`, `unknown-bucket`, `citation-validity`, `stop-continue`, `steer`,
`model-switch`, `retry-after-steer` and `follow-up`. Its gate: every must-pass
check passes in every run, and at least 90% of soft checks pass.

```bash
xvfb-run -a node scripts/eval.mjs --smoke
xvfb-run -a node scripts/bench.mjs --smoke
EVAL_PROVIDER=anthropic EVAL_MODEL=... EVAL_API_KEY=... \
  xvfb-run -a node scripts/eval.mjs [--only name] [--runs 3]
```

`EVAL_BASE_URL` and `EVAL_THINKING` are optional. `eval.mjs --smoke` runs only
`public-aws` with the fake model; it proves the harness and scoring run, is
not a quality result and never fails the exit code. `bench.mjs --smoke` runs
every scenario with the fake model under the same gate, so a failure is a
plumbing regression. A real eval run exits non-zero when a must-pass check
fails. Reports go to `.amp/in/artifacts/eval-report.{md,json}` and
`bench-report.{md,json}`; they name the model and never include the key.

## Packaging

`electron-builder` reads the `build` block in `package.json`:

- macOS: `.dmg` and `.zip`, x64 and arm64, notarized when secrets exist;
  `scripts/after-sign.cjs` ad-hoc signs the app when they do not.
- Windows: NSIS `.exe`.
- Linux: AppImage and `.deb`.
- Update feeds: `latest.yml`, `latest-mac.yml`, `latest-linux.yml`.
- SBOM: `sbom.json`.

There are no native Node addons; QuickJS ships as WebAssembly and is unpacked
from the asar. The release workflow is described in [release.md](release.md).

## Release work

1. Run the local gates you intend to claim: typecheck, lint, unit tests,
   build, budget, contrast, E2E, audit E2E, shots and visual, and the relevant
   eval and bench.
2. Bump `package.json` and `package-lock.json`.
3. Commit, tag the commit `v<version>` and push the tag. Never move a
   published tag.
4. Watch the Release workflow.
5. When the change touches packaging or `electron-updater`, install the
   previous release and check the update path by hand.

## Known gaps

- Real-model evaluation and signed installers need external credentials.
  Without them the repository runs the smoke evaluation and unsigned
  packaging, and must not present that as a quality or signing claim.
- No automated test covers the native file picker or save dialog.
- Search indexes titles, user messages and the agent's text, not tool
  results, memory documents, method code, attachments or object names.
- Delegation is foreground; there is no background child queue.
- No test proves the agent's judgement. The eval scores answers against fake
  storage, not real accounts.
- The axe gate covers serious and critical violations, and
  `scripts/contrast.mjs` covers the secondary-text token pairs; neither is a
  full accessibility certification.
