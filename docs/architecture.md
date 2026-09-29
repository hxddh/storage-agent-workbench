# Architecture

```text
Tauri v2 shell (Rust) ── main window · Quick Ask window · tray · menu · deep links · shortcuts
        │  spawns the Sidecar on a free loopback port with a per-launch token
React window (frontend/)  ── HTTP + SSE (X-Sidecar-Token / ?token=)
        │
Python Sidecar (sidecar/app/)
  api/        FastAPI routers — the only HTTP surface
  agent/      the one Agent: runtime, recorder, session, models, prompt, tools/
  core/       store (tasks, turns, items, artifacts, audit), hub (live fan-out), clock
  engines/    survey, datasets, evidence import
  estate/     rules, store, verify, watch
  providers/  model endpoints, storage accounts (secrets via the vault)
  reports/    the task report
  s3/, analysis/, error_triage/, security/, skills/  deterministic engines and floors
```

## Items, turns and forks

A **Task** is a tree of **Turns**; `turns.parent_turn_id` links a branch and `tasks.head_turn_id` marks the branch being read. `core/store.py`:

- `create_turn(task, direction, parent_turn_id=None)` — continues from the head; `parent_turn_id="<turn>"` forks after that Turn; `""` forks at the root. The new Turn becomes the head.
- `branch(task, head)` — the chain from a Turn to the root, oldest first.
- `siblings(task)` — each parent's children in creation order (a parent with two or more is a fork point; `resume` Turns are not versions).
- `leaf_of(task, turn)` — switching to a version opens its newest descendant.

Every event of a Turn is an **item** appended to `items` with a global, monotonic `seq`. Followers resume by `seq`; nothing is inferred from prose. Types: `user_message`, `agent_message`, `tool_call`, `tool_progress`, `tool_output`, `conclusion`, `steer`, `compaction`, `notice`, `error`.

## The agent loop

`agent/runtime.py` owns one asyncio loop on its own thread and one worker per task that drains queued Turns in order. A Turn:

1. **resolves the model** (`providers/models.credentials`): no usable model → the Turn fails with an `error` item whose action is *Open Settings*;
2. **compacts** when the request — the fixed prefix every call carries (instructions + tool definitions, `registry.schema_chars`) plus the branch history — nears 80 % of the context window (`runtime.needs_compaction`): one tool-less summary step folds all but the two latest Turns into a `compaction` item. The window is the declared one, else the model table (longest matching family name wins), else 128k for a hosted model; a local / self-hosted endpoint (Ollama, LM Studio, vLLM, llama.cpp, OpenAI-compatible off the official host) without a declared window is planned as **16 384** tokens (`providers/models.context_window`);
3. **runs the SDK loop** — `Runner.run_streamed(agent, [], context=TurnContext, max_turns=60, run_config, session=ItemsSession(task, turn), error_handlers={max_turns, model_refusal})`:
   - the SDK reads the history from `ItemsSession` — `session.to_input(items of the branch)`: messages, function calls with their recorded outputs (what the model read, `model_output`), the recorded conclusion as a `record_conclusion` call/output pair, the latest compaction first;
   - `RunConfig.call_model_input_filter` applies the SDK's `ToolOutputTrimmer` (older tool outputs shortened; harder below a 64k window) and injects **steer** messages at a stable position on every call;
   - one tool output reaches the model bounded to a quarter of the window (≥ 4 000, ≤ 60 000 chars; `runtime.tool_output_chars`);
   - `ToolExecutionConfig(max_function_tool_concurrency=6)` bounds parallel calls;
   - tracing metadata carries the task and turn ids to the local trace processor;
4. **streams**: text deltas go to the hub as the live segment; a segment closes into an `agent_message` item when a tool call or message boundary arrives (the `StreamSanitizer` holds back a tail and masks secret-shaped strings before anything is published);
5. **ends**: `completed`; on Stop `cancelled` (partial work kept); on a step-budget overrun (the SDK's `max_turns` error handler) or a recoverable provider error one tool-less **finalize** call writes the answer from the work so far; a model refusal (the `model_refusal` handler) becomes the answer as recorded; otherwise `failed` with a user-actionable message. A remembered endpoint refusal (parallel tool calls, usage reporting) is not sent again.
6. after the first answer, a tool-less **title** step names the task unless the user renamed it.

**Restart**: `RUNTIME.recover()` stamps Turns left `running` as `interrupted` and submits one `resume` Turn per chain on the same branch (the model sees the completed calls and a note); queued Turns are picked up again.

## Tools

`agent/tools/registry.py` — see `docs/tools.md`. `build_sdk_tools(responses)` turns each registered function into an SDK `FunctionTool` with its JSON schema from the signature (not strict: optional arguments stay optional; slimmed — no titles, real enums, one-line descriptions), a scope **input guardrail**, and a timeout. On the Responses backend every core tool (including `survey_account`) is loaded and the rest of each group becomes a deferred `tool_namespace` behind the hosted `ToolSearchTool`; on Chat Completions every tool is sent. With one storage account an omitted `provider_id` is that account. `invoke()` clamps arguments, records `tool_call`/`tool_output` items and an audit row through the Turn's `Recorder`, redacts the result, and returns it bounded inside the untrusted-data envelope. `record_conclusion` is special: it validates and records a `conclusion` item (findings and/or next steps; the answer is the Turn's final message). Each call's `CallContext` carries a `StopSignal` that the Turn's Stop or the call's own timeout sets; tool bodies check `ctx.cancelled` between units of work, because a worker thread cannot be killed.

## Models

`agent/models.py` builds one client per Turn (closed after it). On the official endpoint the main loop uses the Responses **websocket** transport (`OpenAIResponsesWSModel`); an endpoint that refuses it is remembered (`NO_WEBSOCKET`) and served over HTTP from then on — a Turn refused before anything streamed runs once more over HTTP; side steps (title, compaction, finalize) always use HTTP.

| | Responses (official OpenAI endpoint) | Chat Completions (everything else) |
| --- | --- | --- |
| Tools | core loaded; other groups deferred behind hosted tool search | all sent |
| Context | server-side compaction at 80 % of the window; portable compaction between Turns | portable compaction between Turns |
| Storage | `store=False`; encrypted reasoning carried within a Turn only | — |
| Usage | reported | requested (`include_usage`) unless refused |
| Always | temperature 0.2 (none for reasoning models, which reject it), bounded `max_tokens`, 600 s timeout, SDK retry ×2, reasoning effort for known-reasoning models, parallel tool calls unless refused |

## Streaming

`core/hub.py` is an in-process fan-out: each follower (an SSE response) owns a bounded asyncio queue fed with `call_soon_threadsafe` from the agent thread. It carries durable items, live deltas of the segment being written, task state (`working` / `queued` / `needs_attention` / `ready`, the running Turn, the queue, the head), Turn rows as they change and a global feed of task changes. `GET /tasks/{id}/events?after=<seq>` subscribes first, replays items after `seq` from SQLite, sends the live snapshot and the current state, then follows; items are de-duplicated by `seq` and a follower that fell behind re-reads the table. Losing the hub loses nothing durable.

The frontend's `store/task.ts` is one reducer over the snapshot (`GET /tasks/{id}`) and those events. The reducer keeps every turn it has seen (`turn` events) and the head, inserts items by `seq`, and merges a reloaded snapshot rather than replacing it; the stream opens `after` the snapshot's `last_seq`. `store/derive.ts` projects sections (one per Turn on the branch, oldest first — the conversation), tool rows, findings, figures and versions. `store/tasks.ts` follows `GET /events` for the sidebar.

## The estate

- `estate/rules.py` — deterministic rules over a survey posture (status enums and booleans) and over security/lifecycle review findings; a blind spot decides nothing; fixes are generated text (public access block, default encryption, lifecycle), none where the fix depends on intent.
- `estate/store.py` — `ingest_survey` / `ingest_review` project tool results onto `estate_buckets` and `issues` (+ `issue_events`); a survey that saw the whole account forgets buckets it no longer lists; `digest()` is the bounded block every Turn's instructions carry (known buckets per account, ≤ 12 open Issues); the 12 most recent notes follow it as an enveloped `estate_notes` block.
- `estate/fixpacks.py` — each fix's formats (CLI · Terraform · document; names shell-quoted / HCL-escaped) and the **impact preview**: anonymous-request counts from the bucket's S3 server access logs in DuckDB (aggregates only), the recorded lifecycle/versioning posture, and what the change does; `unknown` with a gap when the evidence cannot tell.
- `estate/notes.py` — notes (user · agent · accept), redacted, bounded, audited; the 12 most recent reach the prompt inside the untrusted-data envelope.
- `estate/store.py` also keeps `posture_history` (appended on change, last 50 per bucket) and serves the bucket sheet's history (posture changes + `issue_events`).
- `estate/verify.py` — `POST /issues/{id}/verify` re-runs the rule's read-only review, scope-checked and audited.
- `estate/watch.py` — opt-in per account, off by default, interval 1 h – 7 d; the Sidecar's clock (`STORAGE_AGENT_WATCH_TICK_SECONDS`, default 60 s) runs due sweeps: the survey engine (≤ 500 buckets), a read-only re-check of what posture cannot decide (≤ 25 buckets), and only when a high or medium Issue opened or came back, one task (`origin = watch`) through `RUNTIME.submit`. Turning the watch off stops a scheduled sweep between phases. The last three watch surveys per account are kept.

## The report

`reports/report.py` renders Markdown from the branch's items: title and one meta line, Goal, Conclusion (only a pre-v9 conclusion's `answer`), one Findings list, Next steps, the record of each Direction, Coverage and gaps (failed or refused calls), tools used, outputs, attached evidence, usage and an always-present Safety section — only the module's own words localized (en/zh).

## The shell

`src-tauri/src/lib.rs` spawns the Sidecar (PyInstaller one-dir resource) on a free loopback port with `STORAGE_AGENT_AUTH_TOKEN`, a launch nonce it verifies on `/health`, the app data directory and its own PID (the Sidecar exits with its parent). It builds the menu bar (commands mirrored in `hooks/useNativeAgent.ts`), the tray (Open · Quick Ask · Quit; tooltip set by the window via `set_tray_status`), the Quick Ask window (`index.html?view=quick`), global shortcuts, deep links (`storage-agent://task/<id>`, also used by `open_task_in_main`) and notifications. Single-instance: a second launch focuses the first.

## Dependencies

Verified versions are pinned in `sidecar/requirements.lock` (openai-agents 0.22.3, openai 3.20, fastapi 0.141, sse-starlette 3.5, mcp 2.2, duckdb 1.5.6, pyarrow 25, pandas 3.0) and `frontend/package-lock.json` (React 19.3, Vite 8.3, Vitest 5, TypeScript 7, Tailwind 4.3, Playwright 1.63).
