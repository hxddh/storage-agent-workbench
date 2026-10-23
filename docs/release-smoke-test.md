# Release smoke test

> **Current release: Storage Agent v14.0.0.** This checklist describes the
> current `main` and gates the next candidate desktop build.
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

## B. Agent workspace smoke

A user must be able to recognize and use the product without reading source code.

### Home and navigation

- [ ] A fresh install shows one small Agent mark, one heading, **What should I look into?**, and the Composer directly beneath it, centred as one block — no wizard, landing hero, prompt links, readiness paragraph, account lines, connection rows or Issue table.
- [ ] The sidebar is New task, search, the task list grouped by day, and Settings — **no Storage entry, no bucket count, no estate picker**.
- [ ] There is exactly one window. No second window, popup or Quick Ask appears at launch, from a shortcut, from the tray or from the menu.
- [ ] The UI follows the system language on first run (Chinese on a Chinese system) until the user picks one.
- [ ] ⌘K focuses the sidebar search; ⌘I shows Evidence and closes it when Evidence is already open; Esc closes the pane; its edge drags (352–880 px). Dark and light themes are both first-class.
- [ ] On a narrow window, choosing a task from the sidebar closes the sidebar so the chosen task is visible.

### One control path

- [ ] There is exactly one Composer component: centred on Home and docked at the foot of a task. At rest it has the paperclip, the model chip and Send. While work is live it offers **Add to the request** (a steer) and **Stop**.
- [ ] The Composer has no `@` estate picker and no account/bucket chip. A request may name a bucket or account; the Agent resolves it, or asks if ambiguous.
- [ ] A file always makes a new, queued request (never a steer); a file dropped or chosen by paperclip appears in the Composer with a percentage while it uploads and a cancel control. A failed first upload leaves no empty task in the sidebar.
- [ ] The model chip is backed by the real provider list; with the Sidecar unreachable it reads **Runtime offline**.

### A task is one workspace

- [ ] Requests read top to bottom, oldest first. A Turn shows the objective, one quiet receipt (`2 checks · 1s`), the answer, findings as severity dots, and the deterministic result in a **Data** fold beneath.
- [ ] There is no next-step prompt, no suggestions block and no second rendered result in Evidence.
- [ ] While work is live, the running call appears once in the head line, the calls that already returned follow beneath it, and progress, commentary and steers stay in order; when settled, only the receipt remains.
- [ ] The title bar shows no state pill and no progress hairline; state is in the sidebar row, the live workspace and Stop. It names the task only while the sidebar is collapsed.
- [ ] Send four follow-ups in a row, some while the previous one works: each answer lands under its own objective; nothing is reordered, duplicated or left showing *Working*. Reload mid-run and after: the page is identical.
- [ ] A request queued behind running work shows *Queued* with **Withdraw**; withdrawing removes it and later requests still run.
- [ ] Editing a message sends a new version; *1 / 2* switches between versions without a reload. The fork keeps attached files.
- [ ] A running `survey_account` / `import_evidence` row shows real counts; clicking a tool row opens Evidence at that call, expanded.
- [ ] **Evidence** is one scroll and one level: a meta line, one row per call; a row expands in place to a compact human summary and its arguments/output behind **Raw**, with no second page or Back control. Save report, attached files and folded usage follow. The saved report contains no conclusion or next-step section.
- [ ] A task longer than 60 Turns opens at its newest Turns and offers **Load earlier turns**; loading them does not move the head or reorder the conversation.

### Steering, stopping and recovery

- [ ] Adding to a running request reaches the model once, in the running turn (after any tool still running returns); sent during the final answer it becomes the next request; with nothing running it becomes a new request.
- [ ] **Stop** ends the turn promptly and keeps the partial work (one *Stopped* note).
- [ ] Kill the Sidecar while the app is running: the shell starts it again on the same port, the window leaves **Runtime offline**, and the task reloads without relaunching the app.
- [ ] Kill the Sidecar during a running turn: after the restart the work continues once on its own as a `resume` turn, before any queued follow-up; if that is interrupted too, the task shows *Needs attention* with **Continue** / **Open Settings** — no crash loop.

### Connections and Settings

- [ ] Settings › **Connections** lists the configured storage services, adds or edits one, masks keys, and shows the connection test at the end of the editor.
- [ ] A connection's **Watch** is Off · 6 h · Daily · Weekly, with Check now; a watch opens an ordinary task when something new turns up, not a storage dashboard.
- [ ] The connection form keeps the session token and bucket/prefix scope under *Advanced*; saving stays on the saved connection and does not pull the reader back.
- [ ] Deleting a connection asks first.
- [ ] Settings › General exposes theme, language, one folded Safety line and Advanced; Settings › Models keeps local context windows under the local preset and hosted windows under Advanced.

## C. Storage capability smoke

Use synthetic/local test data and non-sensitive test providers where available.

- [ ] Read-only provider connection/credential checks work.
- [ ] Bounded bucket/object inspection works and respects provider bucket/prefix scope.
- [ ] A representative storage diagnosis uses real Tools and produces an evidence-grounded Workspace result.
- [ ] Account/bucket survey/config review returns bounded/sanitized results.
- [ ] Attach a supported local inventory/access-log file; local deterministic analysis completes and the Agent receives only bounded derived context.
- [ ] Dataset truncation/coverage state is visible/truthful when an ingest cap is hit.
- [ ] Deterministic supported S3-error triage works even with no model provider configured.

## D. Evidence import smoke

- [ ] `import_evidence` accepts only an inventory or access-log source a survey discovered; an arbitrary URL or object is refused.
- [ ] The import is bounded (≤ 500 files / 256 MiB per call, disk headroom) and audited `approved_by=agent`.
- [ ] There is no approval card, plan or separate confirmation step: the bounded call runs directly, and Stop ends it between files.
- [ ] The imported result attaches back to the Task and can be analyzed; raw rows never enter model context.
- [ ] Audit state is persisted and sanitized.

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
- [ ] Evidence import cannot exceed its server-side bounds (source, 500 files / 256 MiB, disk headroom), whatever the model asks.

### Trust and evidence

- [ ] Tool-derived external data is treated as untrusted data rather than instructions.
- [ ] Unsupported provider capability is distinguishable from access denied and from a successfully absent setting.
- [ ] Missing Evidence remains an explicit gap, not a generated fact.
