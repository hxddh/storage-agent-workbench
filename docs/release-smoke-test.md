# Release smoke test

> **Current baseline: Storage Agent v7.0.0.**
>
> Run this against a candidate desktop build before publishing. Packaging health is necessary but not sufficient: the release must preserve the Agent Task product model, runtime truth, safety boundaries, and durable behavior.

## A. Artifact and packaging smoke

- [ ] Candidate commit is the exact intended release source and required CI is green.
- [ ] macOS Apple Silicon build produces `Storage Agent.app` and the expected `.app.zip`; DMG is present when the release workflow produces it.
- [ ] `codesign --verify --deep --strict "<Storage Agent.app>"` succeeds for the ad-hoc seal.
- [ ] macOS seal does not accidentally enable a hardened-runtime configuration that prevents the bundled PyInstaller Sidecar from launching.
- [ ] Linux x64 `.deb` and Windows x64 setup executable are non-empty and installable on their target platforms.
- [ ] All platform-specific `SHA256SUMS-*` files are present and verify the downloaded artifacts.
- [ ] Launching the desktop app starts the packaged Sidecar and reaches a connected/ready state.
- [ ] `GET /health` returns Sidecar liveness.
- [ ] User data is created under the OS application-data directory, never inside the installed application bundle/directory.
- [ ] Closing the desktop app cleans up the packaged Sidecar process.

## B. Agent Task product smoke

A user must be able to recognize and use the product without reading source code.

### Home and navigation

- [ ] A fresh install shows the greeting (the page's one heading), the **Composer** and three starters — not a wizard. A starter only fills the Composer. Without a model or storage account one sentence says what to add, each part a link to Settings; the survey starter is hidden without storage.
- [ ] The UI follows the system language on first run (Chinese on a Chinese system) until the user picks one.
- [ ] The sidebar is New task, search, the task list grouped by day, and Settings — no Home or Estate entries. Rows show Working (pulsing), Queued, Needs attention; Rename and Delete work; ↑/↓ move between tasks.
- [ ] With storage configured, **Needs attention** lists open Issues most severe first (six, then a count), each naming its bucket; a row opens the **bucket sheet** in the side pane. One quiet line per account shows buckets, last check and watch.
- [ ] ⌘K opens the palette (Recent tasks and Actions); ⌘I toggles Details; Esc closes the pane; its edge drags (352–880 px). Dark and light themes are both first-class.

### One control path

- [ ] There is exactly one Composer. At rest it sends; while work is live it offers **Add to the request** (a steer) and **Stop**. A file always makes a new, queued request.
- [ ] The model chip is backed by the real provider list; with the Sidecar unreachable it reads **Runtime offline**.

### A task is one conversation

- [ ] Requests read top to bottom, oldest first: the message, one activity line (*the running tool* or *Thinking* while live; *n steps · t* when done, expanding to commentary and each call), the streaming text, then the answer with findings as severity dots and figures from the deterministic analyses.
- [ ] Send four follow-ups in a row, some while the previous one works: each answer lands under its own request; nothing is reordered, duplicated or left showing *Working*. Reload mid-run and after: the page is identical.
- [ ] A request queued behind running work shows *Queued* with **Withdraw**; withdrawing removes it and later requests still run.
- [ ] Editing a message sends a new version; *1 / 2* switches between versions without a reload.
- [ ] After the latest answer, up to three recorded next steps appear as suggestions; one fills the Composer and is not sent.
- [ ] A running `survey_account` / `import_evidence` row shows real counts; a tool row names the storage account, not its id.
- [ ] **Details** shows Save report (the report in the UI language, conclusion first), usage, every tool call (one opens with arguments and output) and attached files. The conversation reflows beside it; nothing is clipped.

### Steering, stopping and recovery

- [ ] Adding to a running request reaches the model once, in the running turn; with nothing running it becomes a new request.
- [ ] **Stop** ends the turn promptly and keeps the partial work (one *Stopped* note).
- [ ] Kill the Sidecar during a running turn and relaunch: the work continues once on its own as a `resume` turn, before any queued follow-up; if that is interrupted too, the task shows *Needs attention* with **Continue** / **Open Settings** — no crash loop.

### Bounded evidence import

- [ ] `import_evidence` runs inside the turn without an approval card; a request larger than 500 files / 256 MiB is clamped and the result says coverage is partial.
- [ ] A source the survey did not discover is refused; with less than 1 GiB free nothing downloads; **Stop** ends the import between files; the import is audited (`approved_by=agent`).

### A bucket

- [ ] The bucket sheet shows its Issues (resolved folded), configuration (deviations first, *Show all*), notes (Enter adds) and history (folded). *Ask about this bucket* only fills the Composer.
- [ ] **Show fix** offers CLI · Terraform · JSON with Copy and a plain-sentence impact preview; **Verify** re-checks read-only; the menu offers Open task and Accept risk (a reason is kept as a note).
- [ ] Settings › Storage accounts keeps notes on each account and on all storage, and each account's Watch (Off · 6 h · Daily · Weekly, Check now).

## C. Storage capability smoke

Use synthetic/local test data and non-sensitive test providers where available.

- [ ] Read-only provider connection/credential checks work.
- [ ] Bounded bucket/object inspection works and respects provider bucket/prefix scope.
- [ ] A representative storage diagnosis uses real Tools and produces an evidence-grounded Work Result.
- [ ] Account/bucket survey/config review returns bounded/sanitized results.
- [ ] Attach a supported local inventory/access-log file; local deterministic analysis completes and the Agent receives only bounded derived context.
- [ ] Dataset truncation/coverage state is visible/truthful when an ingest cap is hit.
- [ ] Deterministic supported S3-error triage works even with no model provider configured.

## D. Managed Evidence Import smoke

- [ ] Planning a managed Evidence Import downloads nothing.
- [ ] The import is limited to a discovered source and bounded file/byte/time scope (≤ 500 files / 256 MiB per call).
- [ ] No Decision state is entered; the Agent-confirmed import executes only the selected bounded file set.
- [ ] Stopping the Execution before download performs no download.
- [ ] Import result/evidence attaches back to the Task and can be reviewed.
- [ ] Audit state (`approved_by=agent`) is persisted and sanitized.

## E. Safety spot checks

### Secrets

- [ ] Provider/model API responses never return plaintext cloud/model credentials.
- [ ] SQLite contains only opaque secret references, not secret values.
- [ ] No secret appears in model context, logs, Tool detail, audit payloads, reports, screenshots, or localStorage.
- [ ] The encrypted local vault works without a system keychain/secret-service authorization prompt in the current unsigned/ad-hoc distribution model.
- [ ] A vault decryption failure is surfaced safely without exposing vault contents.

### Sidecar authorization

- [ ] Packaged app requests carry the per-launch Sidecar token.
- [ ] Non-exempt requests without the token are rejected when packaged auth is enabled.
- [ ] `/health` remains available for liveness.
- [ ] SSE auth does not leak into packaged uvicorn access logs.

### Storage safety

- [ ] No destructive/mutating S3 capability is present.
- [ ] No generic shell/arbitrary subprocess/raw S3 client capability is exposed to the Agent.
- [ ] Provider bucket/prefix scope is enforced server-side.
- [ ] Object listing/preview/range behavior respects runtime bounds.
- [ ] A full/materially large scan cannot bypass its configured limit (survey ≤ 500 buckets, reports `truncated`).
- [ ] Managed Evidence Import cannot exceed its server-side bounds (source, 500 files / 256 MiB, disk headroom), whatever the model asks.

### Trust and evidence

- [ ] Tool-derived external data is treated as untrusted data rather than instructions.
- [ ] Unsupported provider capability is distinguishable from access denied and from a successfully absent setting.
- [ ] Missing Evidence remains an explicit gap, not a generated fact.
- [ ] Chain-of-thought/hidden reasoning is absent from persisted/UI artifacts.

## F. Failure-state smoke

- [ ] Sidecar unavailable: UI reports the runtime problem and does not invite actions that cannot succeed; user draft text is preserved where supported.
- [ ] No model configured: read-only deterministic/offline capabilities remain truthfully available; model-required execution gives an actionable state.
- [ ] Model/provider rejection or network error becomes **Needs attention** / a clear execution failure rather than a misleading empty Task.
- [ ] A failed first delegation does not accumulate meaningless empty durable Tasks if the current cleanup contract applies.
- [ ] A task/document load failure has a clear recovery action.
- [ ] A storage Tool hard error is not presented as successful absence/default configuration.

## G. UI quality and accessibility smoke

- [ ] Light and dark themes preserve readable text contrast.
- [ ] Keyboard access works for Task navigation, shortcuts, the side pane, and the one Composer without firing task-navigation keys while editing text.
- [ ] Focus is contained/restored correctly for overlays.
- [ ] English and Chinese UI preserve the same product semantics and states.
- [ ] Narrow-window layout remains usable.
- [ ] The real-state visual-review artifact covers at least Delegate, Working+Steer, a bounded evidence import tool row, the Result (conclusion · full answer), the Work log turn (commentary · Worked for …), the side pane, task navigation, runtime failure, narrow layout, and Chinese localization.

## H. Anti-regression checks

The candidate must **not** reintroduce an older application model through documentation or UI drift.

- [ ] The Agent Task remains the primary application object.
- [ ] No second Agent input exists.
- [ ] The side pane remains contextual to the Task.
- [ ] Persistence/API compatibility names do not become product navigation.
- [ ] No fake multi-agent/worktree/terminal/browser/plan UI exists, and no approval card or approval policy returns.
- [ ] Current architecture/legacy/documentation contract tests pass.

## I. Release record

Before publication record:

- candidate source SHA;
- CI/workflow run links;
- platforms manually smoke-tested;
- checksum verification result;
- any smoke item not run and why;
- known release-specific gaps.

Never mark an unchecked item as passed merely because another automated gate was green.

## Native shell smoke (desktop builds)

- The menu bar shows **Storage Agent · Edit · Task · View · Window · Help**; **Task → New Task** clears to the empty start; **Storage Agent → Settings…** (⌘,) opens the Settings dialog; **View → Toggle Sidebar** collapses the sidebar once (no double toggle from the accelerator).
- Opening `storage-agent://task/<id>` from a terminal (`open` / `xdg-open` / `start`) focuses the window and opens that Task; a second launch with the link does not start a second Sidecar.
- With a Task working in the background (switch to another Task), one OS notification arrives when it settles; clicking it returns to the app.
- ⌘⇧S / Ctrl+Shift+S from another app brings the window forward with the Composer focused.
- The OS window title reads `<task> — Storage Agent`.
- After the first Work Result of a new Task the sidebar title changes from the truncated Direction to a short runtime title; renaming the Task and delegating again keeps the user's name.
- With a reasoning model active (for example `o3-mini`), the Composer chip reads `model · Default` and offers Low / Medium / High; with `gpt-4.1` it offers nothing.
- Settings → Model Providers `+` shows presets; Cloud Providers presets include MinIO and Custom (S3-compatible); Skills & bridges **Open skills folder** reveals the folder and **Export trace…** writes a JSON file.
