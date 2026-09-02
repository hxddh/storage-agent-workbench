# Roadmap

> **Baseline: Storage Agent v1.10.0** — the native Agent window (sidebar ·
> title bar · one Task document · one Composer) on a native OS shell and the
> durable task runtime.
>
> This file describes what comes **after** the current architecture. It is not
> a backlog of old UI concepts and it is not proof that an aspirational
> capability already exists. Every item was checked against the code on
> `main`; each carries a verdict: **keep**, **rebuild**, **new**, or
> **non-goal**.

## 1. Verdict on v1.10.0

v1.09 replaced the presentation; v1.10 made the shell and the runtime native.
What is genuinely native now:

| Area | State on `main` | Verdict |
| --- | --- | --- |
| Window, tokens, sidebar, Composer, document renderers, Review sheet, Settings dialog | v1.09 native window, unchanged | keep |
| Tauri OS shell | `lib.rs` builds the menu bar, emits `menu-command` / `deep-link-request` / `shortcut-event`, exposes `notify` / `set_window_title` / `open_app_folder`; `tauri.conf.json` registers `storage-agent://`; one frontend bridge (`useNativeAgent.ts`) with a browser no-op; an architecture test keeps both sides in step | keep |
| Task titles | Runtime title step after the first Work Result (`task_runtime/titling.py`, `sessions.title_source`); user rename wins | keep |
| Reasoning effort | `model_providers.reasoning_effort`, forwarded only for known-reasoning models; Composer chip `model · effort` | keep |
| Execution detail | A document in the Review sheet on `LiveTrace` | keep |
| Provider settings, Skills & bridges | Native panes with presets and actions | keep |
| Frontend API layer | One submit path (execution runner); the pre-v0.94 message client is gone; orphan-module contract | keep |
| Runtime core | `session_agent.py` is still one ~2,700-line module (prompt, loop, steer queue, usage, guards). Correct and covered, but every runtime change touches it. | **rebuild (split)** |
| Window state | Size/position are not remembered across launches. | **new** |
| Updater | `tauri-plugin-updater` is registered but inert: no pubkey, no endpoints. | **new (blocked on signing)** |

## 2. Codex → Storage Agent map

| Codex | Storage Agent | Verdict |
| --- | --- | --- |
| Threads sidebar, New thread, generated thread titles | Sidebar, New task, runtime task titles | keep |
| Thread search (⌘K) | Command palette (⌘K) | keep |
| Archive thread | Delete only; archive stays out of the product. | non-goal |
| Composer: `+` attach, model picker, reasoning effort, approval mode | `+` / drag-and-drop attach, model chip, reasoning effort chip. No approval-mode chip: storage tools are read-only by contract and Decisions gate data movement. | keep / non-goal |
| Image attachments | Not applicable to object-storage work. | non-goal |
| Streaming "Thinking" summaries | Chain-of-thought is never persisted or rendered (security §6.10). *Working* shimmer only. | non-goal |
| *Worked for Ns* tool group | *Worked for …* group | keep |
| Diff / Changes panel | Review sheet: Evidence · Execution · Report | keep |
| Approval prompt for commands | Decision card (Approve / Decline) | keep |
| Automations (scheduled runs) | Revisit schedules are a runtime engine; no scheduler UI. | non-goal (UI) |
| Skills, MCP | User skills, read-only MCP bridge; Settings offers actions | keep |
| Local models | Local providers with presets | keep |
| Native app menu, ⌘, Settings, notifications, deep links | Shipped in v1.10.0 | keep |
| Multiple windows, worktrees, terminal, browser | — | non-goal |

## 3. Next workstreams

Ordered by value. Each lands as one PR with code, tests, and docs together
(CLAUDE.md §11). No migration is expected; head stays **028** unless a
workstream names one.

### N1 — Split `session_agent.py`

Prompt assembly, tool loop, steer queue, usage accounting, and guards become
separate modules with the existing tests unchanged (they patch
`session_agent.SESSION_LOOP` and read `_streamed_session_loop`; the seam and
the names stay re-exported from `session_agent`). A pure refactor: no
user-visible change, no new capability, its own PR.

### N2 — Window state

Remember window size and position across launches (a Tauri window-state
plugin or a small app-data JSON). Keep the macOS traffic-light inset and the
minimum size.

### N3 — Signed updates

Wire `tauri-plugin-updater` once a signing key and an endpoint exist
(`docs/signing.md`). Until then the plugin stays inert and no UI mentions
updates.

### N4 — Product polish inside the contract

- Empty-start greeting rotates between two or three short lines; still no
  cards, no wizard.
- `⌘⇧[` / `⌘⇧]` previous / next task.
- `Esc` clears a Composer draft only when the draft is empty.
- Per-task *Export trace…* from the Review sheet (same OTel path as Settings).

## 4. Non-goals (unchanged)

Multi-agent orchestration, coding projects/worktrees, terminal/browser/computer
control, workflow canvas, synthetic plans or checklists the runtime did not
emit, destructive storage mutation, a scheduler UI, approval-mode switches that
weaken the read-only floor, chain-of-thought rendering, a page per backend
table, multi-user semantics.

## 5. Roadmap principles

1. **Capability before chrome.** Add UI only for runtime state/capability that actually exists. A listener for an event nothing sends is chrome.
2. **Agent Task remains the organizing object.** New evidence, tools, reports, and execution detail attach to the Task.
3. **Read-only autonomy, explicit mutation/data-movement boundaries.** More autonomy must not weaken the safety floor. Remediation Plans stay operator-applied.
4. **Evidence over confidence.** Improve what the Agent can prove, correlate, and explain; do not hide gaps. Estimates always carry coverage.
5. **Storage depth over generic-Agent breadth.** Prefer real S3/object-storage capabilities over generic terminal/browser/workflow features.
6. **Provider realism matters.** S3-compatible behavior and capability gaps must be tested explicitly rather than assumed from AWS semantics.
