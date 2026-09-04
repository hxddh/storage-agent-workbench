# Release smoke test

> **Current baseline: Storage Agent v1.17.2.**
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

A user must be able to recognize and use the v1.09 product model without reading source code.

### Start and task navigation

- [ ] The product identity is **Storage Agent** in the window/release-facing UI.
- [ ] A fresh install exposes one greeting line and a **Composer** in the middle band — not a wizard, hero heading, or suggestion cards.
- [ ] The window is sidebar · title bar · document. There is no activity bar, status bar, or Details/inspector column.
- [ ] The Composer shows the active model as a chip backed by the real provider list; switching it activates that provider.
- [ ] The Composer does not paint a persistent keyboard legend (`⏎ Delegate` / `⇧⏎`).
- [ ] Global navigation is a single chronological Agent Task title list in the sidebar; collapsing it moves the toggle and New task into the title bar.
- [ ] The New task button is labelled **New task**; ⌘N / Ctrl+N still works and is not painted on the button.
- [ ] A labeled **Search** sits under New task and opens the command palette (same overlay as ⌘K). It is not an inline list filter.
- [ ] Task rows support Rename and Delete without turning navigation into a backend-record browser.
- [ ] Creating/delegating initial work creates a durable Task that remains available after reload/restart.

### One control path

- [ ] There is exactly one primary Agent composer/control.
- [ ] At rest it represents **Delegate**.
- [ ] During active execution it exposes real **Steer** and **Stop** behavior for the same Task.
- [ ] Opening the Artifacts panel does not create another Agent input.
- [ ] ⌘K / Ctrl+K opens a command overlay over the Task; it is not a new destination.
- [ ] Dark and light themes are both first-class; switching language does not change product semantics.

### Direction → Execution → Work Result

- [ ] User input is presented as **Direction** / task intent, not as an old chat-product shell.
- [ ] Active work enters **Working** based on real runtime state.
- [ ] Real Tool activity becomes visible in the Work Result as one **Worked for …** group of tool rows; no synthetic plan/worker/sub-agent UI is invented.
- [ ] A completed turn produces a durable **Work Result** that survives reload.
- [ ] Tool rows remain linked to the Work Result that produced them.
- [ ] Structured storage errors render as storage/error artifacts where applicable rather than losing useful fields in generic prose.

### Steering and stopping

- [ ] While a real execution is in flight, entering a steering Direction changes the active work through the runtime steering path rather than creating a second task/input.
- [ ] **Stop** cancels the active turn promptly (including a queued Direction).
- [ ] A stopped execution leaves a truthful durable partial/stopped result/state as implemented and the Task becomes controllable again.
- [ ] A `needs_attention` Task whose last Execution is interrupted/failed exposes **Resume**; Resume follows the new execution event stream.
- [ ] Settings contains model, storage credentials, language, and theme as a centered dialog — not a storage price table.
- [ ] Composer has no `/checkup` `/cost` `/drift` SKU menu. Typing `/` is ordinary text.
- [ ] There is no task header destination and no Overview / revisit / Verify painted chrome. The title bar is name + state; ⌘F opens a find strip on the reading column; ⌘K and the sidebar Search row open the palette. There is no document ghost Find.
- [ ] Cost-review numbers in a Work Result are labelled estimates with coverage, or explicit gaps when inventory/price table is missing.
- [ ] Cost / inventory / Drift / access-log figures render from runtime artifacts with coverage and Estimate; unconfirmed prices withhold the cost axis; missing series are gap states, never interpolated.
- [ ] A finding with a provenance chain opens Evidence anchored to that finding; a missing chain is labelled, not implied.
- [ ] A Direction queued behind a running Execution is visible in the Task and can be cancelled.

### Durable task switching / concurrent state

- [ ] Start real work in Task A, switch to Task B, then return to Task A.
- [ ] Task A retains/reconnects to the same real in-flight or completed execution state rather than being reset because it was not visible.
- [ ] Navigation reflects Working/Needs decision/Needs attention/Ready truth for relevant Tasks.
- [ ] The UI does not describe this as a fleet of hidden autonomous background Agents.

### Waiting for approval

- [ ] When the Agent calls `import_evidence`, the title bar reads **Waiting for approval** and an approval card appears inline in the transcript at that point.
- [ ] The card states why confirmation is required and the bucket/prefix/files/bytes bounds from the real plan.
- [ ] Nothing downloads before **Allow**; the same Execution continues afterwards with the import result.
- [ ] **Deny** records the durable resolution, performs nothing, and the Agent answers from what it has; **Allow for this task** lets a later call of the same type proceed as a recorded, already-approved Decision.
- [ ] Stop while waiting withdraws the request (recorded as declined).
- [ ] Reload/reopen a Task with a still-current durable Decision: the Decision remains visible from persisted truth.
- [ ] A newer real active execution correctly outranks an older persisted Decision where the runtime contract says work is already active.

### Artifacts panel

- [ ] Evidence / Reports / Plans / Baselines / Execution detail open in the **Artifacts panel** beside the active Task (⌘I).
- [ ] The Artifacts panel does not replace the Agent Task with a separate application destination.
- [ ] The one Composer remains logically owned by the active Task while Artifacts is open.
- [ ] Evidence/Execution details display persisted sanitized truth.
- [ ] Markdown Report is a durable Task Artifact and survives reload.

### Task paging/search/navigation

- [ ] A long Task loads recent durable work first and can fetch older history without losing current execution state.
- [ ] Find/semantic step navigation works on Task-native content.
- [ ] Narrow-window behavior preserves access to Task navigation and the active Task without restoring retired layout contracts.

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
- [ ] The plan shows bounded source/file/byte/time scope.
- [ ] The Task enters a real Decision state before cloud evidence movement.
- [ ] Confirming the plan executes only the selected bounded import.
- [ ] Rejecting/cancelling performs no download.
- [ ] Import result/evidence attaches back to the Task and can be reviewed.
- [ ] Audit/approval state is persisted and sanitized.

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
- [ ] A full/materially large scan cannot bypass its configured limit/Decision boundary.
- [ ] Managed Evidence Import cannot auto-confirm itself.

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
- [ ] Keyboard access works for Task navigation, shortcuts, Artifacts, and the one Composer without firing task-navigation keys while editing text.
- [ ] Focus is contained/restored correctly for overlays.
- [ ] English and Chinese UI preserve the same product semantics and states.
- [ ] Narrow-window layout remains usable.
- [ ] The real-state visual-review artifact covers at least Delegate, Working+Steer, Waiting for approval, the transcript turn (commentary · Worked for … · answer), the Artifacts panel, task navigation, runtime failure, narrow layout, and Chinese localization.

## H. Anti-regression checks

The candidate must **not** reintroduce an older application model through documentation or UI drift.

- [ ] The Agent Task remains the primary application object.
- [ ] No second Agent input exists.
- [ ] The Artifacts panel remains contextual to the Task.
- [ ] Persistence/API compatibility names do not become product navigation.
- [ ] No fake multi-agent/worktree/terminal/browser/plan UI exists without runtime support.
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
