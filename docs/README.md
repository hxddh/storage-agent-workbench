# Documentation

> **Current architecture baseline: Storage Agent v1.08.0** (`v1.08.0`).
>
> The normative product invariant is: **the Agent Task is the application**.
> v0.94.0 shipped the durable runtime; v0.95.0 made it user-visible; v0.96.0
> added quantified storage engines under that runtime. v0.97–v0.99 were
> presentation passes that still stacked copilot OS chrome. **v1.00.0
> deleted those copilot objects** but kept a workbench shell. **v1.01.0
> replaced that shell with a native Agent window.** **v1.02.0 finishes that
> window:** no leftover chat transcript, no painted Composer/New-task keyboard
> chrome. Empty window = Composer. Center = one readable work record. Tools
> appear in that record. Sidebar = quiet titles. Settings is hidden. Overlay
> Review. Engines remain in the Sidecar with no product UI entry. **v1.03.0 keeps that window and adds modern native-agent extensions — local models, user skills, read-only MCP bridge, observability export, OS shell — as gated additive features.**

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
| **Decision required** | A real confirmation boundary that blocks gated work. |
| **Work Result** | Durable Agent output for a Task, including inline figures. |
| **Artifact** | Reviewable Evidence, Execution detail, or Report, opened as an overlay. |
| **Review** | Light overlay over the active Task. Not an application destination. |
| **Delegate / Steer / Stop** | The one Agent control path. |

Historical compatibility vocabulary such as `session`, `run`, `session_message`, and `tool_call` remains valid inside Sidecar persistence/API code and narrowly scoped frontend adapters. It does **not** define the product information architecture.

## Current documents

- [`product.md`](product.md) — product model, UX semantics, states, design rules, non-goals.
- [`design-tokens.md`](design-tokens.md) — presentation tokens (type, color, motion, elevation, `--viz-*` series).
- [`architecture.md`](architecture.md) — Tauri/React/Sidecar topology and ownership boundaries.
- [`security.md`](security.md) — secret, tool, model-context, evidence and approval guarantees.
- [`api.md`](api.md) — localhost Sidecar API; distinguishes product-level `/agent-tasks` projection from compatibility `/sessions` APIs.
- [`data-model.md`](data-model.md) — SQLite/DuckDB/files, migrations through 027, and product-to-persistence mapping.
- [`tools.md`](tools.md) — actual Agent-accessible capability classes and safety bounds.
- [`roadmap.md`](roadmap.md) — post-1.02 priorities and explicit non-directions.
- [`install.md`](install.md) — installation and local data behavior.
- [`packaging.md`](packaging.md) — Sidecar/Tauri packaging topology.
- [`release.md`](release.md) — release workflow and support matrix.
- [`release-smoke-test.md`](release-smoke-test.md) — release acceptance checks.
- [`release-template.md`](release-template.md) — release-note template using current vocabulary.
- [`signing.md`](signing.md) — signing/notarization status and constraints.

## Historical documents

- [`releases/`](releases/) records what each release changed at the time.
- [`v0.92-agent-os-rebuild.md`](v0.92-agent-os-rebuild.md) is a historical design/rebuild record superseded by v0.93.
- [`../CHANGELOG.md`](../CHANGELOG.md) is chronological history and may intentionally contain terminology that is no longer current.

Historical documents must not be mechanically “modernized” in ways that falsify history. Instead, current normative docs and automated documentation contracts prevent historical vocabulary from becoming current architecture again.

## Documentation maintenance contract

A change that modifies product architecture, task state, public frontend ownership, API contracts, persistence shape, safety boundaries, packaging, or release behavior must update the matching current document in the same PR.

For architecture changes, update at minimum:

- `CLAUDE.md`;
- `docs/product.md`;
- `docs/architecture.md`;
- the executable architecture/documentation contracts under `frontend/src/agent/`.
