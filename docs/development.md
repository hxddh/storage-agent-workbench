# Development

## Requirements

- Node 24 or newer (Node 26 also works)
- npm 10+
- Linux desktop builds need the usual Electron runtime libraries; CI uses
  `ubuntu-latest`

## Commands

```bash
npm ci
npm run dev          # Electron + Vite with HMR
npm run typecheck    # tsconfig.node.json + tsconfig.web.json
npm run lint         # Biome
npm test             # Vitest
npm run build        # out/{main,preload,renderer}
npm run budget       # initial renderer bundle under 500 KiB
xvfb-run -a npm run perf  # cold start to composer under 1 s
npm run audit        # production dependency audit
npm run sbom         # CycloneDX SBOM
npm run dist:dir     # unpacked app in release/
npm run dist         # installers for the current OS
```

## Tests

- **Vitest** covers what must not drift: local policy evaluation, exposure, the
  twelve rules and their tri-state evaluation, the account rule, TLS policy
  detection, the Issue lifecycle (accepted, gone, recurred), the schema migrations,
  code mode (sandbox, scope, budgets, timeout), demo storage, generated fixes and impact, log
  normalization and IP masking, CSV/Parquet import, the aggregate whitelist,
  the search index and its escaping, the entry → UI projection, the brief's
  current-state folding, verdict grounding, the run guardrails, redaction and
  the tool floor, and the brief in jsdom, provider capabilities, posture diffs, permission diagnosis, model windows, access paths and batch fixes.
- **Domain tests** (`src/main/domain.test.ts`) run the real AWS SDK and the
  real tools over HTTP against `scripts/fake-s3.mjs` profiles — AWS, an
  S3-compatible store without policy status, a denied ACL, a condition-narrowed
  policy, CORS `*`, versioning — into a real SQLite estate.
- **Compatibility** (`src/main/compat.test.ts`) runs survey against moto, an
  independent AWS emulator, for exposure, the account-wide block and access
  reads where the emulator supports them. It runs
  only with `STORAGE_AGENT_AWS_ENDPOINT`; the `compat` CI job starts
  `moto_server`:

  ```bash
  pip install 'moto[server]==5.2.4' && moto_server -p 5055 &
  STORAGE_AGENT_AWS_ENDPOINT=http://127.0.0.1:5055 npx vitest run src/main/compat.test.ts
  ```
- **Playwright + Electron** (`scripts/e2e.mjs`) drives the real window against
  `scripts/fake-s3.mjs` (delayed, so a running call is observable) and
  `scripts/fake-model.mjs`: configure a model, add an account, ask a question,
  see the running row, open the evidence, accept a risk, apply a fix outside
  the app and verify it, get a grounding correction, ask for a fix, stop a run,
  continue it, search and open a hit, answer a question with code mode, walk
  findings by keyboard, pick a bucket with `@`, re-verify without a model,
  export evidence, run axe with zero serious violations, and open the demo
  account.
- **Eval** (`scripts/eval.mjs`) runs scenarios against a real model in the real
  window and scores findings, grounding, honesty about blind reads, memory
  first, verify-after-fix, code mode for open questions (largest prefix),
  re-surveying stale memory and call counts. `--smoke` checks the plumbing with
  the fake model (CI runs it); the `Eval` workflow runs it with a real model on
  demand.
- **`scripts/shots.mjs`** captures the states that matter under
  `.amp/in/artifacts`; `scripts/budget.mjs` enforces the first-paint budget.

Run the E2E headless:

```bash
xvfb-run -a node scripts/e2e.mjs
```

## Packaging

`electron-builder` reads the `build` block in `package.json`. There are no
native addons, so no rebuild step is required. The release workflow signs and
notarizes when `CSC_LINK`, `APPLE_ID` and the related secrets exist; otherwise
the app is unsigned, macOS asks for confirmation on first open, Windows
SmartScreen warns, and macOS cannot update itself. `latest*.yml` feeds are
attached to every release for `electron-updater`.

Outputs: `release/linux-unpacked`, `.AppImage`, `.deb`, `.dmg`, `.zip`, `.exe`.

## Release

1. `npm run typecheck && npm run lint && npm test && npm run build`
2. Run the E2E and the shots script; inspect the screenshots. Run the eval
   against the model you recommend and read the report.
3. Bump `version` in `package.json`.
4. Commit, tag `vX.Y.Z`, push the tag.
5. The release workflow builds macOS, Linux and Windows and attaches the
   artifacts to the GitHub release.

## Known gaps

- Attachments are exercised at the import/aggregate level and through the
  composer; there is no automated test of the native file dialog or the save
  dialog.
- Search indexes text only: titles, requests, findings and the current verdict,
  not attachments or object names.
- No import of data from the previous major version; the database starts empty.
- The live eval needs a model key; it is a release gate for a human, not part of
  pull-request CI.
- Real-model scoring and signed/notarized installers need external
  credentials; the repository cannot fabricate them. Everything else is
  exercised locally.
