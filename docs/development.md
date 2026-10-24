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
npm run dist:dir     # unpacked app in release/
npm run dist         # installers for the current OS
```

## Tests

- **Vitest** covers what must not drift: local policy evaluation, exposure, the
  seven rules and their tri-state evaluation, the Issue lifecycle (accepted,
  gone, recurred), the v4 migration, generated fixes and impact, log
  normalization and IP masking, CSV/Parquet import, the aggregate whitelist,
  the search index and its escaping, the entry → UI projection, the brief's
  current-state folding, verdict grounding, the run guardrails, redaction and
  the tool floor, and the brief in jsdom.
- **Domain tests** (`src/main/domain.test.ts`) run the real AWS SDK and the
  real tools over HTTP against `scripts/fake-s3.mjs` profiles — AWS, an
  S3-compatible store without policy status, a denied ACL, a condition-narrowed
  policy, CORS `*`, versioning — into a real SQLite estate.
- **Playwright + Electron** (`scripts/e2e.mjs`) drives the real window against
  `scripts/fake-s3.mjs` (delayed, so a running call is observable) and
  `scripts/fake-model.mjs`: configure a model, add an account, ask a question,
  see the running row, open the evidence, accept a risk, apply a fix outside
  the app and verify it, get a grounding correction, ask for a fix, stop a run,
  continue it, then search and open a hit.
- **Eval** (`scripts/eval.mjs`) runs scenarios against a real model in the real
  window and scores findings, grounding, honesty about blind reads, memory
  first, verify-after-fix and call counts. `--smoke` checks the plumbing with
  the fake model (CI runs it); the `Eval` workflow runs it with a real model on
  demand.
- **`scripts/shots.mjs`** captures the states that matter under
  `.amp/in/artifacts`.

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
- The live eval needs a model key; it is not part of CI.
- The account-level public access block (S3 Control) is not read; exposure
  details say so.
