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

- **Vitest** covers the domain logic that must not drift: the seven rules and
  their tri-state evaluation, generated fixes and impact, log normalization and
  IP masking, CSV/Parquet import, and the aggregate whitelist.
- **Playwright + Electron** (`scripts/e2e.mjs`) drives the real window against
  `scripts/fake-s3.mjs` and `scripts/fake-model.mjs`: configure a model, add an
  account, ask a question, expand the survey, then ask for a fix.
- **`scripts/shots.mjs`** captures the states that matter under
  `.amp/in/artifacts`.

Run the E2E headless:

```bash
xvfb-run -a node scripts/e2e.mjs
```

## Packaging

`electron-builder` reads the `build` block in `package.json`. There are no
native addons, so no rebuild step is required. The app is unsigned; macOS will
ask for confirmation on first open, and Windows SmartScreen will warn.

Outputs: `release/linux-unpacked`, `.AppImage`, `.deb`, `.dmg`, `.zip`, `.exe`.

## Release

1. `npm run typecheck && npm run lint && npm test && npm run build`
2. Run the E2E and the shots script; inspect the screenshots.
3. Bump `version` in `package.json`.
4. Commit, tag `vX.Y.Z`, push the tag.
5. The release workflow builds macOS, Linux and Windows and attaches the
   artifacts to the GitHub release.

## Known gaps

- Deleting a task removes its `task_meta` row; pi's entries stay in the database
  (no cross-store cascade yet).
- Attachments are exercised at the import/aggregate level and through the
  composer; there is no automated test of the native file dialog.
- Watch scheduling is verified manually through **Check now**; CI does not wait
  for an interval.
- No import of data from the previous major version; the database starts empty.
