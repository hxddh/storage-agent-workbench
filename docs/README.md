# Documentation

> **Current architecture baseline: Storage Agent v1.17.1** (`v1.17.1`).
> v1.16.0 finished the true native agent; v1.16.1 patched tables, search,
> wrapping, and a first Codex-grade polish pass. **v1.17.0 is the Codex
> window** (`docs/releases/1.17.0.md`); **v1.17.1** patches queue honesty,
> Settings container layout, and title-bar Find (`docs/releases/1.17.1.md`).
> The next plan lives in `docs/roadmap.md`.
>
> The normative product invariant is: **the Agent Task is the application**.
> v0.94.0 shipped the durable runtime; v0.95.0 made it user-visible; v0.96.0
> added quantified storage engines under that runtime. v1.00–v1.03 removed the
> copilot/workbench shells and added gated native-agent extensions. v1.04–v1.08
> painted a web-app chassis (activity bar, status bar, Details inspector) on top.
> **v1.09.0 tears that chassis down.** The window is sidebar · title bar · one
> Task document · one Composer. Empty start is a greeting and the Composer.
> Execution is one *Worked for …* group in the Work Result. Decision is an
> approval card. Settings is a centered dialog. Engines remain in the Sidecar
> with no product UI entry.
> **v1.10.0 makes the shell and the runtime native.** A real menu bar, deep
> links, notifications and a summon shortcut reach the window through one
> bridge; the runtime names tasks after the first Work Result and takes a
> reasoning effort for models that accept one; Execution detail and the
> provider panes are native documents; the pre-v0.94 message client is gone.
> **v1.11.0 is Codex parity all the way down.** A turn is a transcript: user
> bubble, commentary segments, one *Worked for …* group, an inline approval
> card where the gated `import_evidence` tool raised it, then the answer as
> plain Markdown. No metadata JSON block, no proposal list, no separate import
> dialog; Artifacts is a right split panel; the Agent runtime is split by
> responsibility.
> **v1.12.0 is native all the way through.** One protocol (the `/sessions`
> message/turn/prepare shims are gone), a push-driven event stream with
> `task.status`, the model's `update_plan` checklist, an approval policy
> (ask · session · always) enforced in one place with the large-survey gate,
> context compaction (`context.compacted`, ⌘K Compact context), `AGENTS.md`
> instructions, Execution detail from the durable log, wall-clock *Worked
> for …*, and the frontend split into document / runner / api modules.
> Migration head is **030** (v1.13.0–v1.16.0 add no migration).
> **v1.14.0 is interaction truth and content craft.** Steering reaches waiting
> executions, queued Directions edit until they run, Execution detail shows
> measured usage, figures and evidence read localized, times read relative,
> and inputs are bounded where the server bounds them.
> **v1.15.0 is the true native agent.** Work language on the one input, one
> static greeting plus the Composer, Settings alone in the sidebar, painted
> search with CJK single-char find, self-healing streams, fitting tables,
> one usage vocabulary, dict-owned copy, and elevated craft.
> **v1.16.0 finishes the true native agent.** Dict-owned copy, engine asks and
> shortcuts in the palette, governor and memory reuse beside tokens, a labeled
> window denominator, disambiguated approvals, isolated Escape, dismissible
> errors, backed-off reconnects, a themed last resort, and matching secret
> shapes.
> **v1.17.0 is the Codex window.** ContextMeter lives in the model menu;
> the empty start is greeting + Composer with no glyph; the user bubble is
> a quiet fill; approval is sentence-case hairline; *Worked for {t}* is
> wall-clock only; attachments are per-task; copy is Direction / Execution
> / Work Result.
> **v1.17.1 patches that window.** Queued banners never reprint the live
> Direction; Settings fields follow the editor pane; quiet Find/palette
> icons return to the title bar. Find is a compact overlay (⌘F). Auto-
> compaction triggers at 60 % of the window.
> No migration (head stays **030**).
> **v1.13.0 is honesty and completeness.** The MCP bridge executes instead of
echoing, the OTel export carries real spans, restart recovery covers waiting
executions, unknown execution kinds are rejected, compaction chains and
triggers without reported usage, the Composer completes `@` files with a
redacted history, the palette fuzzy-ranks, approvals project scan bounds,
golden evals pin quality, and the updater is wirable from the environment.

This directory documents the currently shipped Storage Agent architecture and operating contracts. It is deliberately organized so implementation agents and contributors do not reconstruct older product shells from historical terminology that still exists in persistence, APIs, release notes, or git history.

## Source-of-truth order

When documents disagree, use this order:

1. **Current code and executable architecture tests** — runtime truth wins.
2. **`CLAUDE.md`** — contributor/agent implementation contract.
3. **`docs/product.md`** — canonical product semantics and UX vocabulary.
4. **`docs/architecture.md`** — current frontend/runtime ownership boundaries.
5. **`docs/security.md`** — non-negotiable safety and secret-handling contract.
6. **Specialized current docs** (`api.md`, `data-model.md`, `tools.md`, packaging/release docs).
7. **`docs/roadmap.md`** — future direction, never evidence that a capability already exists.
8. **Release notes / CHANGELOG / historical rebuild documents** — historical record only; never an implementation specification for current work.

If a historical document describes `Investigation`, `SessionRail`, `Workbench`, application-level Runs/Evidence/Report surfaces, a separate Steering surface, a thread/chat-first shell, a Settings price table, Composer slash SKUs, a first-run wizard, or Review Overview, that description is historical. Do not restore it.

## Current product vocabulary

Use these terms in product-facing and new frontend architecture work:

| Current concept | Meaning |
| --- | --- |
| **Agent Task** | The durable unit of delegated work and the primary application object. |
| **Direction** | User objective, constraint, correction, or steering input. |
| **Execution** | Real runtime/tool work; never a synthetic plan. Shown as tool rows in the document. |
| **Approval** (Waiting for approval) | A real confirmation boundary a gated tool raises inside the Execution; Allow · Allow for this task · Deny. |
| **Work Result** | Durable Agent output for a Task, including inline figures. |
| **Artifact** | Evidence, Execution detail, Reports, Plans, Baselines/Drift in the Artifacts panel. |
| **Artifacts panel** | Right split over the active Task (⌘I). Overlay only under a narrow window. Not an application destination. |
| **Delegate / Steer / Stop** | The one Agent control path. |

Historical compatibility vocabulary such as `session`, `run`, `session_message`, and `tool_call` remains valid inside Sidecar persistence/API code and narrowly scoped frontend adapters. It does **not** define the product information architecture.

## Current documents

- [`product.md`](product.md) — product model, UX semantics, states, design rules, non-goals.
- [`design-tokens.md`](design-tokens.md) — presentation tokens (type, color, motion, elevation, `--viz-*` series).
- [`architecture.md`](architecture.md) — Tauri/React/Sidecar topology and ownership boundaries.
- [`security.md`](security.md) — secret, tool, model-context, evidence and approval guarantees.
- [`api.md`](api.md) — localhost Sidecar API; distinguishes product-level `/agent-tasks` projection from compatibility `/sessions` APIs.
- [`data-model.md`](data-model.md) — SQLite/DuckDB/files, migrations through 030, and product-to-persistence mapping.
- [`tools.md`](tools.md) — actual Agent-accessible capability classes and safety bounds.
- [`roadmap.md`](roadmap.md) — next direction after **v1.17.1**. Delivered history lives in `releases/`.
- [`install.md`](install.md) — installation and local data behavior.
- [`packaging.md`](packaging.md) — Sidecar/Tauri packaging topology.
- [`release.md`](release.md) — release workflow and support matrix.
- [`release-smoke-test.md`](release-smoke-test.md) — release acceptance checks.
- [`release-template.md`](release-template.md) — release-note template using current vocabulary.
- [`signing.md`](signing.md) — signing/notarization status and constraints.

## Historical documents

- [`releases/`](releases/) records what each release changed at the time.
- [`history/v0.92-agent-os-rebuild.md`](history/v0.92-agent-os-rebuild.md) is a historical design/rebuild record superseded by v0.93.
- [`history/design-rebuild-2026.md`](history/design-rebuild-2026.md) and [`history/review-modern-2026.md`](history/review-modern-2026.md) are v1.04-era review notes, superseded by v1.09.0 and v1.10.0.
- [`../CHANGELOG.md`](../CHANGELOG.md) is chronological history and may intentionally contain terminology that is no longer current.

Historical documents must not be mechanically “modernized” in ways that falsify history. Instead, current normative docs and automated documentation contracts prevent historical vocabulary from becoming current architecture again.

## Documentation maintenance contract

A change that modifies product architecture, task state, public frontend ownership, API contracts, persistence shape, safety boundaries, packaging, or release behavior must update the matching current document in the same PR.

For architecture changes, update at minimum:

- `CLAUDE.md`;
- `docs/product.md`;
- `docs/architecture.md`;
- the executable architecture/documentation contracts under `frontend/src/agent/`.
