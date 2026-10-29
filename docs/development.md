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

`npm test` is the fast suite. It covers `call` over a fake S3 (any read runs
and returns what the service answered, policy documents parsed, the error
code and HTTP status of a failed call, a body read up to the bytes asked for,
anything not a read and any bucket outside scope refused before a request,
account ids scrubbed, a stopped call as stopped), a long result cut to its
first piece and read on with `more`, notes without secrets and forgetting only
the agent's own, `ask`, code mode (sandbox, paging every object, scope inside
a script, running until stopped, SQL over an attached log), log normalization
and IP masking, CSV/Parquet import, schema migrations through 16 and provider
deletion, the search index, entry → UI projection (including 35.x entries and
calls to tools of earlier versions), the live projection, the conversation
thread (order, steers, the live slot, citations, what each call returned,
Markdown), the prompt (hard rules, no ceiling, no hook, every note in the
digest), the output limit a provider's refusal names, redaction, provider
capabilities, AWS profiles, the model catalog and the localized dictionaries. `Conversation.test.tsx` and `Composer.test.tsx` run in
jsdom; the rest use Node.

### Domain and compatibility

- `src/main/domain.test.ts` runs the real AWS SDK and the real tools over HTTP
  against `scripts/fake-s3.mjs`, whose responder is `scripts/fake-s3-core.mjs`:
  bucket profiles that answer as real providers do, including their 403s and
  501s. It uses a real SQLite database.
- `src/main/compat.test.ts` runs `call` against moto, an independent AWS
  emulator, as a custom-endpoint account: what AWS says about exposure, the
  account-wide block, account-level IAM, a KMS key policy and CloudTrail events
  (with the account id never sent on). It runs only with
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
  `scripts/fake-model.mjs`, a fake OpenAI-compatible endpoint that reads with
  `call` (`ListBuckets`, `GetBucketPolicyStatus`, `GetBucketAcl`,
  `GetBucketPolicy`, `GetBucketLifecycleConfiguration`) and with `query` via
  `tools.call`, and answers from what came back. It
  covers model setup from the fetched list, adding an account, axe on
  Settings, Home and the conversation (serious/critical violations fail), Home
  without **Check account** or demo storage, an answer built from `Read` steps
  with the 35.x scaffolding (`Earlier in this task`, `Not checked`, `Worked
  for`, `Findings`) absent, a citation opening a `call` step as the response's
  JSON with exactly what the agent received, a follow-up in
  the same thread, `@` focus, a clarifying question answered by an option, a
  fix applied outside the app and the agent's re-read, a change written as the
  agent's own text, stop/continue (the reply lands after the divider), search
  opening an agent text, and code-mode rows and a script that uses
  `tools.call`.
- `scripts/e2e-audit.mjs` starts with no model and no account and checks that
  the composer is disabled, that **Set up a model** and **Add an account** are
  offered, that **Check account** and **Try with demo storage** are not, and
  that no account, task or conversation appeared on its own. It captures the
  no-model state.
- `scripts/shots.mjs` captures Home (empty, configured, dark, compact, Chinese),
  Settings (model, account form, appearance, dark, compact, a Chinese test
  error), the conversation (task, citation open, tool detail, follow-up, memory
  in a new task, live, a written change, dark, compact) and the compact sidebar
  under `.amp/in/artifacts`.
- `scripts/visual.mjs` compares those captures to `visual/baseline`
  (`01-home-light` … `24-citation-open`, including `13-memory-light` and
  `14-change-light`). It rejects a global pixel change above 5% and any 64px
  tile with a large local change, so a missing control is not hidden by a
  large unchanged window. The baselines were regenerated for 37.0, where the
  steps read `Read` and open as JSON.
- `scripts/perf.mjs` launches three times and fails when the median time to a
  visible composer exceeds 1,000 ms.
- `scripts/budget.mjs` excludes the lazily loaded `Settings`, `Conversation`
  and `Markdown` chunks and fails when the remaining renderer JavaScript
  exceeds 500 KiB.

### Evaluation

`scripts/eval.mjs` has 28 scenarios. A model drives the real window against
fake S3 profiles whose truth is known, and each run is scored on the agent's
last answer: the right buckets called public, no bucket called public that is
not, what it could not read said out loud and no claim of a clean account, the
expected conditions or prefixes named (the largest prefix is computed from the
fake storage's own objects), a fix given as text, and no claimed write. Calls
are reported, not judged: a failed call is not counted against the agent, since
a 404 such as `NoSuchBucketPolicy` is a normal answer, and how much to read is
the agent's. Scenarios include
an S3-compatible store, a denied ACL, a condition-narrowed policy, a fix
applied mid-task, memory in a new task, large and stale prefixes, and a
prompt-injection-shaped object key.

`scripts/bench.mjs` has 13 agent-behavior scenarios scored on the conversation:
`public-account`, `blind-acl`, `memory`, `clarify`, `fix`, `query`,
`unknown-bucket`, `citation-validity`, `stop-continue`, `steer`,
`model-switch`, `retry-after-steer` and `follow-up`. A scenario that expects
reads expects the `Read` label. `--smoke` runs them with the fake model.

```bash
xvfb-run -a node scripts/eval.mjs --smoke
EVAL_PROVIDER=anthropic EVAL_MODEL=... EVAL_API_KEY=... \
  xvfb-run -a node scripts/eval.mjs [--only name] [--runs 3]
```

`--smoke` runs only the `public-aws` scenario with the fake model. It proves the
harness and scoring plumbing run; it is not a quality result and never fails
the exit code. A real run exits non-zero when a must-pass check fails and
writes `.amp/in/artifacts/eval-report.md` and `.json`. The report names the
model and never includes the key.

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
   budget, contrast, E2E, audit E2E, shots/visual, and the relevant eval and
   bench.
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
- The sidebar shows the 500 most recently updated tasks; older rows remain in
  SQLite but are not shown. Settings and the prompt hold every note.
- Removing an account deletes its account and bucket notes. See
  [data-model.md](data-model.md).
- The tools return what the APIs answer; no test proves the agent's judgement
  of them. The eval scores answers against fake storage, not real accounts.
- There is no import from an earlier version of the app.
- The E2E axe gate covers serious and critical violations; `scripts/contrast.mjs`
  guards the secondary-text token pairs. It is not a full contrast certification.
