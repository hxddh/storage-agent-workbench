# CLAUDE.md

> **Implementation contract for Storage Agent v13.0.0.**
>
> Before changing product structure, read `docs/README.md`, `docs/product.md`,
> `docs/architecture.md` and `docs/security.md`. Current code and the
> executable contracts (`frontend/src/contracts.test.ts`, `sidecar/tests/test_v500_*.py`,
> `sidecar/tests/test_v600_kernel.py`, `sidecar/tests/test_v700_followups.py`,
> `sidecar/tests/test_v800_*.py`, `sidecar/tests/test_v900_*.py`, `sidecar/tests/test_v1000_*.py`,
> `sidecar/tests/test_v1100_*.py`, `sidecar/tests/test_v1200_*.py`,
> `sidecar/tests/test_v1300_agent_workspace.py`) are authoritative. v5 was a clean rewrite; v6–v13 build on it: do not reconstruct earlier information architecture, tables or routes
> from git history or release notes. No plan mode, todo lists, approvals, mode switches,
> sub-agents or workflow builders — new capability lands on Task, item stream and estate.

Storage Agent is a local-first desktop Agent for object storage and S3-compatible systems. It is not a generic chatbot, storage admin console, ticket system, or coding Agent.

The product invariant:

> **The Task is the window's object; the estate is the Agent's memory. One item stream is the truth.**

What the Agent learns about the user's storage — accounts, buckets, their posture, and the Issues found there — outlives the Task that learned it, but it is reached through the Agent, not a storage/bucket navigation tree. Everything that happens in a Task is one ordered, append-only stream of **items**; the page, the report, the audit and the trace are projections of it.

## 1. The model

- A **Task** is a tree of **Turns**. A Turn is one **Direction** and the work it caused. `turns.parent_turn_id` links a branch; `tasks.head_turn_id` is the branch being read. Editing a Direction submits a new Turn with the same parent — a **fork** — and the reader can switch between versions (`‹ 1 of 2 ›`).
- **Items** (`items`, global monotonic `seq`) are the only record of work: `user_message`, `agent_message`, `tool_call`, `tool_progress`, `tool_output`, `conclusion`, `steer`, `compaction`, `notice`, `error`. Turn lifecycle is `notice` items (`started`, `completed`, `failed`, `cancelled`, `interrupted`, `resumed`, `stopped`, `finalized`, `compacted`, `titled`, `imported`, `reprompted`). Nothing else is a source of truth for what happened. A `user_message` may carry legacy API estate `context` refs (focus, never authorization; the v13 Composer does not send them); a `conclusion` may carry the Turn's successful calls as `evidence` (attached by the recorder, never written by the model).
- The model's history for a Turn is the item chain from that Turn to the root of its branch, converted to model input by `agent/session.py:to_input` in branch order (each Turn's items by `seq`; a batch of parallel calls replays as all calls then all outputs, so a strict Chat Completions endpoint accepts it; commentary is an assistant output message; a dangling call gets an "interrupted" output; a recorded conclusion replays as its call with "Conclusion recorded."; the latest `compaction` stands in for the Turns it folded; the running Turn's own steers are left to the input filter, so each reaches the model once; a steer recorded while a tool batch was still running replays after that batch's outputs; steers `carried` into the next Direction are read there only).
- The **estate** is the Agent's memory, not a window surface (v13): `estate_buckets` (+ a bounded `posture_history`, appended only when the posture changed, last 50 per bucket), `issues` + `issue_events`, `watch_schedules`, and `notes`. Issues are opened, resolved and marked `recurred` only by deterministic observations (`estate/rules.py`) — never by model prose. A read that could not see something decides nothing. The window never renders a Storage page, bucket page, estate picker or open-Issue counter.
- **Fixes** are text the user applies — Storage Agent never writes to storage. Each generated fix (`rules.generate_fix`; none for a bucket name outside `[A-Za-z0-9._-]`, which no shell quoting protects everywhere) is regenerated on every read — stored text is never served — and carries **formats** (the AWS CLI command, a Terraform resource, the API document; `estate/fixpacks.py`) with the bucket name, endpoint and region shell-quoted / HCL-escaped, and an **impact preview** (`GET /issues/{id}/impact`) built only from evidence the estate holds (it reads access logs already analyzed; it never ingests) — anonymous requests counted from attached S3 server access logs (aggregates only), the recorded posture, and what the change itself does — with verdict `low | caution | unknown` and an explicit gap when the evidence cannot tell. Verify (read-only) resolves an Issue; the next observation that sees it again marks it `recurred`.
- **Notes** are what the Agent wants remembered about the estate, an account or a bucket: written by the Agent (`note` tool) or as the reason a risk was accepted; **not a window surface**; redacted with eager secret masking, ≤ 1 000 chars, ≤ 500 kept (the Agent's oldest trimmed first, audited; never the note just written — when only the user's notes remain, the Agent's note is refused), audited. The 12 most recent reach every turn as an `estate_notes` block inside the untrusted-data envelope — remembered context, never instructions (a hostile source could talk a model into keeping a note). Un-accepting a risk, or the risk resolving, drops its reason.

## 2. Runtime architecture

- Desktop shell: **Tauri v2** (menu bar, tray, Quick Ask window, deep links, notifications, global shortcuts).
- Frontend: **React 19 + Vite + TypeScript + Tailwind CSS v4**.
- Local backend: **Python + FastAPI + Uvicorn** Sidecar.
- Agent runtime: **OpenAI Agents SDK for Python** (0.24.x) — the thin layer only: `Runner.run_streamed` over an SDK `Session` (`agent/session.py:ItemsSession`, the branch read from items), `FunctionTool` with input guardrails and timeouts, `RunConfig.call_model_input_filter`, `RunErrorHandlers` (`max_turns`, `model_refusal`), `ToolOutputTrimmer` (plus in-Turn shrinking of earlier outputs on Chat Completions), model retry, tracing processors; on the Responses backend the websocket transport (`OpenAIResponsesWSModel`, falling back to HTTP once refused; side steps stay HTTP), `tool_namespace` + `defer_loading` + `ToolSearchTool` and server-side compaction.
- Model backends: **Responses API** for the official OpenAI endpoint (`api_style = responses`), **Chat Completions** for every other OpenAI-compatible endpoint (hosted or local).
- S3-compatible access: **boto3 / botocore**. Analytics: **DuckDB + PyArrow + pandas**.
- Metadata: **SQLite** (`storage-agent.db`, WAL), append-only migrations (head **2**).
- Secrets: **AES-256-GCM encrypted local vault** through `security/keyring_store`.
- Streaming: **Server-Sent Events** via `sse-starlette`, resumable by item `seq`.
- MCP: the **official MCP Python SDK** (2.x) serves an opt-in read-only bridge.
- Packaging: **PyInstaller one-dir Sidecar** embedded as a Tauri resource.

```text
Tauri shell ── React window (main) · Quick Ask window · tray
        │ localhost HTTP / SSE + per-launch token
Python Sidecar ── one Agent runtime ── model endpoint configured by the user
        │                            └─ S3-compatible storage configured by the user
        └── SQLite items stream · estate · vault
```

The frontend never receives cloud/model secret values. The Sidecar resolves secret references server-side.

## 3. One Agent, one submit path

There is one model-driven Agent: `sidecar/app/agent/runtime.py` (`RUNTIME`). It runs on its own event-loop thread; each task has one worker that drains its queued Turns in order.

- **Submit** (`POST /tasks`, `POST /tasks/{id}/turns`) creates a Turn and records the Direction as a `user_message` item at once; a Direction submitted while another runs is **queued** durably and can be withdrawn (`DELETE /tasks/{id}/turns/{turn_id}`). There is no other submit path; the watch opens its task through `RUNTIME.submit` too.
- **Steer** (`POST /tasks/{id}/steer`) records a `steer` item and is injected into the running loop by the model-input filter (re-inserted at a stable position on every model call). With nothing running, a steer is a new Direction; one that arrives after the model's last call becomes the next Direction when the Turn completes (a `carried` notice) — a steer is never acknowledged and dropped.
- **Stop** (`POST /tasks/{id}/stop`) sets the Turn's cancel event and cancels the SDK run; each tool call carries a `StopSignal` set by the Turn's Stop **or** that call's own timeout, and bodies check it between units of work (a bucket, a file, a check); the partial work is kept (`cancelled`).
- **Task state** follows the Turn the task is read at (`tasks.head_turn_id`): a failure on a branch the user has moved away from never makes the task need attention.
- **Recovery**: on start, Turns left `running` are stamped `interrupted` and continued **once** as a `resume` Turn on the same branch (never a crash loop), before any Direction queued after it; the reader's head follows the continuation only if they were on that branch; without a usable model the task offers **Resume**.
- **Finalize**: when the step budget (60) runs out (the SDK's `max_turns` error handler) or a recoverable provider error ends the loop, one tool-less call writes the answer from the work so far, reading a history fitted to the input budget; if even that fails the Turn is `failed` with a recorded error (never a canned answer); a model refusal becomes the answer as recorded (`model_refusal` handler); both are marked `finalized`.
- **Budget** (v10): `agent/budget.plan(creds)` is the one place the window, `max_tokens` and the input budget (window − `max_tokens`) are decided; every char→token estimate uses `CHARS_PER_TOKEN` = 3.2. A window ≤ 32k reserves ~2 048 completion tokens; Ollama is sent the planned window as `num_ctx`. On Chat Completions, a running Turn near 85 % of the input budget shrinks its **earlier** tool outputs (oldest first) to enveloped previews; the latest batch stays whole and items keep everything. Request 0 of a first survey fits an 8k window.
- **Small-model guards** (v10): a call identical to one this Turn already made answers “Already called…” without running; arguments that are not JSON are answered, not run; a string where a list/number/boolean belongs is coerced; a final message that is a tool call written as text gets one correction (`reprompted`).
- **Compaction**: before a Turn, when the fixed prefix (instructions + tool definitions) plus the branch history nears 80 % of the **input budget**, one tool-less summary step (reading a fitted history) folds earlier Turns into a `compaction` item — one, several or all of them, down to 60 %, so it does not fire every Turn; the current Direction always stays. The Responses backend also compacts server-side inside a long Turn. The window is the declared one, else the model table (longest match wins); a local / self-hosted endpoint without a declared window is planned as **16 384** tokens.
- **Title**: after a task's first answer, one tool-less step names it (≤ 8 words); a user rename wins forever (`title_source`).
- **Conclusion**: the model records a turn's findings with the typed tool `record_conclusion`, once, right before the final answer (≤ 8 findings with severity `high|medium|low|info`; `next_steps` remains accepted for older turns but is not painted or reported — v9 has no `answer` field: the answer is the Turn's final message, and an older item's `answer` is read, never written). It becomes a `conclusion` item, never a tool row, shown under the answer. A turn without it has no conclusion; nothing is guessed from prose.
- **Tracing**: a local trace processor writes safe span attributes (names, durations — never payloads) to `spans`; `GET /tasks/{id}/trace` exports OTel-shaped spans.

Do not add a second planner/narrator Agent, hidden orchestration, handoffs, or a simulated multi-agent UI. If the runtime does not implement a capability, the UI must not pretend it exists.

## 4. Tools

Tools are declared once with `@tool(group=…, scope=Scope(…), bounds=…, timeout=…)` in `sidecar/app/agent/tools/` and registered in `registry.REGISTRY`. Groups: `core`, `probes`, `objects`, `config`, `account`, `files`, `advice`. Every call:

1. is scope-checked by an SDK input guardrail before it runs (provider bucket/prefix scope; a refusal is a `tool_output` the model reads);
2. has its integer arguments clamped to `bounds` and runs with a timeout in a worker thread, reading its context through `registry.current()` (connection, progress, per-turn budgets — spent under a lock, since parallel calls run in threads — cancel); a thread that outlives its Stop or timeout writes nothing after the Turn's record is closed;
3. is recorded as `tool_call` → (`tool_progress`…) → `tool_output` items and one `audit` row;
4. returns a redacted result, bounded for the model (≤ 60 000 chars, and ≤ a quarter of a small window) and the UI (≤ 24 000 chars), inside the untrusted-data envelope.

Schemas are not strict (optional arguments stay optional), carry real `enum`s for fixed choices and no pydantic titles; descriptions are one or two sentences and never repeat the instructions (`agent/prompt.py`), which keep only method and the safety rules. `provider_id` is optional: with one storage account it is that account; with several the scope check asks for it. A result that names an estate Issue carries the rule's title and severity. Tool-row notes are one short English clause (≤ 60 chars, real plurals).

Storage tools are read-only. `import_evidence` is the only data-moving tool: a survey-discovered inventory or access-log source only, ≤ 500 files / 256 MiB per call (clamped), refused without 1 GiB free disk after the download — decompressed output included, re-checked while combining — audited `approved_by=agent`, stoppable between files. `survey_account` is capped at 500 buckets and reports coverage; its output leads with issue kinds (title, severity, count), estate changes and coverage, and only its bucket rows are cut to fit. The registry is **15 tools** (v10), one per job: always loaded — `survey_account`, `query_estate` (`survey_filter`, `since_last_survey`, scoped `notes` / `issue_events`), `fix_preview` (the generated fix in every format plus its impact preview; read-only), `note` (≤ 5 per turn; never over MCP), `record_conclusion` (never over MCP), `read_skill`, `list_buckets` (filtered by the bucket scope), `triage_error` (an error message or a presigned URL), `analyze_uploaded_file` (typed `metric` / `group_by` / `filters`; the attachment line carries its `dataset_id`); on demand — `probe_endpoint(check=reach|location|addressing|tls|latency)`, `list_objects(kind=keys|versions|uploads)`, `inspect_object(aspects=…; head, attributes, acl, tags, preview, range, conditional)`, `review_bucket_config(aspects=…, detail=…)`, `import_evidence`, `simulate_storage_cost` (bytes per storage class, never a dollar figure). Bundled skills are **5 method cards** (≤ 1 200 chars each: account posture, security/IAM, protocol compatibility, access logs, lifecycle cost); old skill names load their card. `docs/tools.md` must agree with the registry.

## 5. Sidecar API

- `/tasks` — list/create/rename/delete; `POST …/turns` (submit, `parent_turn_id` forks), `…/steer`, `…/stop`, `DELETE …/turns/{id}` (withdraw queued), `…/turns/{id}/resume`, `PUT …/head` (switch branch), `…/files` (upload an access log or inventory), `…/report?lang=en|zh`, `…/trace`.
- `GET /tasks/{id}` — the snapshot (task, branch turns, items, forks, live segment, files, artifacts, `last_seq`); `GET /tasks/{id}/events?after=<seq>` — SSE: durable `item` events (id = seq), live `delta`, `state` (with `head_turn_id`; the current state is sent whenever a stream opens), `turn` (a Turn's public row whenever it is created, starts, settles or is re-parented), `live`. The window opens the stream `after` the snapshot's `last_seq` and merges a reloaded snapshot with what it already holds — nothing is replaced, dropped or duplicated. `GET /events` — the global task feed for the sidebar. Items served to the UI never carry `model_output`.
- `/estate`, `/estate/providers/{id}/buckets` (an account's buckets with open-issue counts, + its notes), `/estate/providers/{id}/buckets/{bucket}` (the bucket page: posture, every Issue, the timeline of posture changes and Issue events, notes), `/issues` (list · one · `fix` · `impact` · `verify` · `accept {accepted, reason}` — a reason is kept as a note), `/notes` (list · create · edit · delete), `/estate/watch/{provider_id}` (`GET` / `PUT {enabled, interval_hours}` / `POST …/run`).
- `/providers/models` (+ `activate`, `test`), `/providers/clouds` (+ `test`).
- `/settings` (language, theme, vault status, standing-instructions status), `/skills`, `/health`, `/health/selfcheck`.
- `/mcp` — only with `STORAGE_AGENT_ENABLE_MCP=1`: Streamable HTTP (stateless) over the registry's stateless read-only subset + `list_providers`, audited as `actor=mcp`.

When `STORAGE_AGENT_AUTH_TOKEN` is set (the packaged app), every route except `/health` requires `X-Sidecar-Token` (or `?token=` for `EventSource`). See `docs/api.md`.

## 6. Non-negotiable security rules

1. Never place cloud access keys, secret keys, session tokens, model API keys, Authorization headers, cookies, signatures, or presigned credentials in model prompts.
2. Never persist plaintext secrets in SQLite, items, logs, reports, traces, screenshots, or frontend state.
3. Store secrets only through `security/keyring_store`; SQLite stores opaque `keyring://…` references only.
4. No generic shell, raw subprocess, raw boto3 client, unrestricted filesystem, terminal, browser/computer control, or arbitrary SQL for the Agent.
5. Storage is read-only. There is no destructive/mutating S3 tool. An Issue's fix is text the user applies; names from a listing are shell-quoted / HCL-escaped in that text.
6. Provider bucket/prefix scopes are enforced server-side (tool guardrail, Verify, MCP bridge).
7. Data movement runs inside hard server-side bounds (above); a survey never exceeds 500 buckets; the watch is opt-in per provider, off by default, read-only, bounded (≤ 500 buckets surveyed, ≤ 25 re-checked) and stops between phases when turned off.
8. Tool inputs/outputs, items, audit rows, reports and model context are sanitized and bounded; tool output reaches the model inside the untrusted-data envelope.
9. Raw access-log/inventory rows never enter model context — deterministic analysis produces bounded aggregates and findings.
10. Chain-of-thought is never persisted, exposed or modeled as an item.
11. Capability gaps on S3-compatible providers are explicit (`provider_unsupported`), never fabricated success.
12. Missing evidence stays a gap. Never manufacture evidence to complete a narrative.

See `docs/security.md`.

## 7. The window

The main window is **sidebar · title bar · one Agent workspace · one Composer**, plus one closable, resizable **Evidence** pane. The Composer is centred on Home and docked at the foot of a task; it is one component with one behaviour. Home is not a dashboard.

- **Sidebar**: New task, an in-place title search (Esc clears), one chronological list grouped by day, and Settings — nothing else. There is no Storage or Bucket entry and no open-Issue count. State is a mark on the row (Working pulses, Queued, Needs attention; Ready paints nothing; a watch-opened task carries the shield). Rename (double-click / More) and Delete. ↑/↓ move between tasks. Below 720 px it overlays the page (closed by default and whenever a page is chosen or the window narrows; a scrim closes it), and the Evidence pane covers the page and closes back to the workspace.
- **Title bar**: chrome, not a second status surface. The task name appears only when the sidebar is collapsed (the sidebar already names the selected task); the Evidence toggle is at the right. No state pill, no progress hairline; state is painted once in the sidebar row and announced once to screen readers.
- **Home**: the greeting (`What should I look into?` / `想让我查什么？`) as the page's one `<h1>`, the Composer directly beneath it, and nothing else — no prompt links, readiness sentence, account lines, connection rows, Issue table or starter cards. The Agent resolves the estate from the request. Nothing on Home submits work on its own.
- **Task workspace**: one workspace per Turn, oldest first. The objective is a compact heading with Edit — a fork — Copy and the version switcher *1 / 2*; editing keeps attached files. There is no user or assistant bubble. A Turn renders the deterministic result from `tool_output.detail` first (a survey wins over a narrower view; listing, issues, config, fix), then the model's short interpretation, findings as severity dots, figures, and one quiet receipt *n checks · t* at the end. While work is live, the trace is open: every real call's verb, target, progress and result, with commentary and steers inline. No next-step prompt is painted; there is no suggestions block and no second rendered result. A stopped Turn keeps what it had written. The page sticks to the bottom while work is live unless the reader scrolled up.
- **Tool rows** read as what the Agent did (labels in `lib/toolLabels.ts`), with the target in mono and the result as a muted note; running survey/import rows show real counts. Clicking one opens Evidence at that call.
- **Evidence** (`inspector/Inspector.tsx`): one scroll and one level. One row per call; a row expands in place to its arguments and raw data, with no second page and no Back control. A call opened from the live trace is expanded and scrolled into view. Save report (the task report in the reader's language, Markdown), attached files and folded usage follow. ⌘I and the title-bar toggle show Evidence and close it when Evidence is already open; Esc closes the pane; drag its edge or use ←/→ on it (352–880 px). A pane opened from a button takes focus and gives it back on close. Evidence is the raw record, not a duplicate result table.
- **Composer** is the only Agent input: centred on Home, docked at the foot of every task; Send at rest (waiting while no model is set up — the chip says where); *Add to the request* (steer) + Stop while work is live. Three controls at rest: paperclip (attach a file), the model chip and Send; drop a file anywhere on it. There is no `@` estate picker and no account/bucket chip: the user names what they mean and the Agent resolves it. A file always makes a new, queued Direction, never a steer. The **model chip** is backed by the real provider list (*Set up a model…* with none; *Runtime offline* when the Sidecar cannot be reached; reasoning effort only for known-reasoning models).
- **⌘K** focuses the sidebar search (there is no command palette). **Settings**: General (theme, language — following the system until chosen — and one folded Safety line: read-only storage · keys stay on this computer · stop any time, with its three points inside; a folded *Advanced*: skills, the standing-instructions file, the MCP bridge) · Models (a local model's context window is asked for, prefilled with 16 384; a hosted one keeps it under *Advanced*) · **Connections** (the configured storage services; each connection's Watch first: Off · 6 h · Daily · Weekly, Check now; the session token and bucket/prefix scope under *Advanced*). This is configuration, not a second navigation surface; notes are Agent memory, not a Settings form. A section starts at its top; saving stays on the saved item and shows its connection test at the end of the editor; a save that finishes after the reader moved on leaves them there; deleting a model or connection asks first. Below 720 px Settings takes the whole screen: one row of section tabs above one scrolling body.
- **Quick Ask**: a second, small always-on-top window (⌘⇧Space, the tray, the View menu). One question becomes one ordinary task (`origin = quick_ask`) through the same submit path; the answer streams there; *Open in the main window* hands the task over via the deep-link event. It is summoned, never restored at launch, has no app menu on Linux/Windows, and closes on Esc or its top-right close through `hide_quick`.
- **Native shell**: menu bar (App · Edit · Task · View · Window · Help) emitting `menu-command`, `storage-agent://task/<id>` deep links, OS notifications when a followed task settles in the background or the watch opens a task, a tray item (Open · Quick Ask · Quit), global shortcuts (⌘⇧S summon, ⌘⇧Space Quick Ask). All of it reaches the window through `frontend/src/hooks/useNativeAgent.ts`; a plain browser is a no-op.

Frontend structure: `api/` (the only module that talks to the Sidecar), `store/task.ts` (one reducer: all known turns + head, items by seq, merged snapshots, SSE), `store/derive.ts` (pure projections: sections, tool rows, findings, figures, versions), `tool/` (typed deterministic result views), `shell/`, `home/`, `task/`, `composer/`, `inspector/`, `settings/`, `quick/`. The `estate/` components no longer exist in the window; the backend keeps the estate for the Agent.

## 8. Design system

Tokens live in `frontend/src/index.css` (see `docs/design-tokens.md`): a cool graphite neutral ladder, one restrained blue accent (primary action, selection, focus, links, live progress), a separate status palette, five type sizes (11 · 13 · 15 · 20 · 24), a 4 px grid, three radii (6 · 8 · 12), two shadows, motion 120/200/280 ms honouring `prefers-reduced-motion`. The document is flat: content carries no card, border or shadow, only hairlines and space; the Composer, menus, the side pane, Settings and code blocks are the only surfaces. Light, Dark and System are first-class; System follows the OS. Controls come from `components/ui.tsx`, styled in `styles/components.css`; surfaces live in `styles/app.css` and `styles/document.css`. No component carries a raw colour; status reads as a dot or badge beside neutral text. Motion uses CSS and View Transitions; there is no animation library.

## 9. Data ownership

SQLite (`storage-agent.db`) stores application metadata and the items stream; migrations are append-only (never edit a shipped entry). DuckDB/local files hold datasets (`<data>/tasks/<task>/datasets/<id>/`). User data lives under the application data directory, never the install directory. On first start the one-shot importer (`app/importer.py`) copies providers (vault references carry over), the estate and each v4 task's Directions/answers/conclusions from a sibling `app.db`, which it never modifies. See `docs/data-model.md`.

## 10. Non-goals

Multi-agent orchestration (bounded parallel tool calls, ≤ 6, are the alternative), coding projects/worktrees, synthetic plans or checklists, generic terminal/browser/computer control, workflow canvas, LangGraph/LiteLLM/Langfuse/n8n, Postgres/Redis, destructive storage repair or mutation, a page per backend table, multi-user SaaS/RBAC.

Gated, opt-in extensions that keep the same floor: user skills (`STORAGE_AGENT_DATA_DIR/skills/*/SKILL.md`, guidance only), standing instructions (`AGENTS.md` / `STORAGE_AGENT_INSTRUCTIONS`, bounded, redacted), local model providers (Ollama, LM Studio, vLLM, llama.cpp, OpenAI-compatible), the read-only MCP server, the proactive watch.

## 11. Development workflow

Work in focused PRs. For architecture or behavior changes: inspect the implementation and its tests first; update the canonical docs in the same PR; add or update executable contracts for boundaries that matter; validate the real rendered/runtime state (the E2E suite and the contact sheet run against the real Sidecar), not only component code.

## 12. Verification expectations

Run the checks relevant to the change and never claim checks you did not execute. CI gates: frontend typecheck, Vitest (unit + contracts + surfaces), production build; Sidecar `ruff` + `pytest` (including the live golden estate/watch tasks against moto S3 and the fake OpenAI-compatible model); an opt-in scenario eval against a **real** model (`sidecar/tests/live_eval/`: 15 seeded moto scenarios with known answers, N runs, deterministic scoring, hard floors on leaked secrets / followed injections / out-of-scope reads; any OpenAI-compatible endpoint via `STORAGE_AGENT_LIVE_EVAL=1` + endpoint env vars, the key needed only for hosted endpoints; the manual `Live model eval` workflow) — never in the default gates, while default CI replays small-model failure shapes and checks request 0 fits 8k/16k/32k; packaged Sidecar smoke; real-Sidecar Playwright E2E and the visual contact sheet; macOS, Linux and Windows desktop builds. Dependency versions actually verified are pinned in `sidecar/requirements.lock` (`scripts/lock-sidecar-deps.py`).

When reporting completion include: what changed; what contract it changes or preserves; what checks ran and their result; what was not run; known gaps.

## 13. Documentation discipline

`docs/README.md` defines precedence. Release notes and the CHANGELOG are history and may carry retired vocabulary; never use them as the specification.
