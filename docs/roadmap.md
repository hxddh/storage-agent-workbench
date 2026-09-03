# Roadmap

> **Status: delivered in v1.15.0** (see `releases/1.15.0.md` and the
> CHANGELOG). Everything below landed as planned, with no migration and no
> second batch. The v1.14.0 plan this file replaces is recorded in
> `releases/1.14.0.md`.

> **Baseline: Storage Agent v1.13.0.** This file is the plan for
> **v1.14.0 — Interaction truth and content craft**: the waiting-state steer
> lands where it belongs, queued work edits, usage renders, figures speak both
> languages, times read relative, inputs are bounded where the server bounds
> them, and the empty start names one engine question a day. The product
> invariant is unchanged: **the Agent Task is the application.** Every finding
> below was checked against the code on `main` at v1.13.0 (merge `822be00`).
> The v1.13.0 plan this file replaces is recorded in `releases/1.13.0.md`.

## 1. Verdict on v1.13.0 — what still is not finished

v1.13.0 made the *runtime* honest all the way through. What remains is the
interaction on top of it and the content inside it: a steer that cannot reach
a waiting execution, a queue that cannot be edited, usage that persists but
never renders, figures that speak one language, times that mislead, inputs
without ceilings, overlays that leak focus, and engines nobody can discover.

| # | Finding (verified in code) | Where | Verdict |
| --- | --- | --- | --- |
| F1 | **Waiting-state steer falls through.** `active_execution` excludes `waiting`; the 409 fallback re-submits guidance-for-the-decision as a queued follow-up. | `task_runtime/runtime.py`, `useTurnRunnerImplementation.ts` | **rebuild** — steer lands waiting |
| F2 | **Queued work is cancel-only.** A typo means cancel and re-queue. | `routers/agent_tasks.py`, `TaskBanners.tsx` | **new** — PATCH + inline edit |
| F3 | **Usage is invisible.** Per-turn token counts persist but surface nowhere. | `ExecutionDetailImplementation.tsx` | **new** — usage row |
| F4 | **Figures speak English only.** ~25 hardcoded strings across viz/*, raw severity tokens, hardcoded `"ready"`. | `viz/*`, `EvidenceReview.tsx`, `AgentRuntimeArtifacts.tsx` | **rebuild** — i18n + SeverityMark |
| F5 | **Times mislead.** Bare UTC slices; frozen relative times; DST-unsafe grouping. | `ArtifactsPanel.tsx`, `ExecutionDetailImplementation.tsx`, `AgentTaskNavigation.tsx` | **rebuild** — shared lib/time |
| F6 | **Inputs have no ceiling.** Pastes die as bare 422s; renames unbounded. | `Composer.tsx`, `AgentTaskNavigation.tsx` | **new** — counters + caps |
| F7 | **Overlays leak focus.** Collapsed sidebar keeps tab stops; overlay panel and model menu lack keyboard contracts. | `AgentTaskNavigation.tsx`, `ArtifactsPanel.tsx`, `ModelChip.tsx` | **rebuild** — inert/trap/listbox |
| F8 | **Document craft gaps.** Dead outline anchors, colliding heading ids, sizeless tables, JSON-wall baselines, 4-language highlighting. | `MarkdownImplementation.tsx`, `ArtifactsPanel.tsx`, `lib/highlight.ts` | **rebuild** — anchors/ids/caption/yaml |
| F9 | **Engines undiscoverable.** Nothing says cost/plans/baselines/reports can be asked for. | `startGreeting.ts`, `prompt.py` | **new** — daily hint + model line |
| F10 | **Four clipboards.** Same copy logic hand-rolled per surface. | `TranscriptTurn.tsx`, `MarkdownImplementation.tsx`, `S3ErrorArtifact.tsx`, `CallDetail.tsx` | **rebuild** — one hook |

## 2. Workstreams (all mandatory for v1.14.0)

### W1 — Steer truth (F1)

- `runtime.steerable_execution`: running/queued first, else a live waiting execution (event + queue push; post-decision delivery or follow-up carry). Pinned by `test_v114_interaction.py`. The 409 fallback stays as a safety net.

### W2 — Editable queue (F2)

- `PATCH .../executions/{eid}` (409 past the queue), audited; inline editor on queued rows (Enter saves, Esc closes).

### W3 — Usage truth (F3)

- Detail matches the Work Result to `turn_metrics`; renders reported fields only.

### W4 — Localized content (F4)

- Viz/evidence/triage through i18n (EN/ZH), one `SeverityMark`, drift/config copy honest about backend strings staying as-is.

### W5 — Honest times (F5)

- Shared `lib/time.ts` (DST-safe), relative everywhere with UTC on hover, minutely ticker.

### W6 — Bounded inputs (F6)

- Composer counter past 75 % (8 000 steer / 32 000 direction), refuse past 100 %; rename capped at 120.

### W7 — Keyboard truth (F7)

- `inert` collapsed sidebar, trapped overlay panel, listbox model menu with arrows/Enter.

### W8 — Document craft (F8)

- Outline for two sections with smooth in-scroller jumps, unique heading ids, editorial h1/h2 weights, table size + TSV copy, baselines as findings + folded raw JSON with copy, yaml/toml/ini highlighting.

### W9 — Discoverability (F9)

- Daily rotating engine hint on the empty start; the model offers engines in one sentence when relevant.

### W10 — One clipboard (F10)

- `hooks/useCopy.ts`; the four surfaces keep identical behaviour.

### W11 — Release

- `releases/1.14.0.md`, CHANGELOG, version stamps, guard bumps (architecture v1.14 block, documentation contract at v1.14.0). No migration.

## 3. Non-goals for v1.14.0

- A suggestion-card grid or slash commands (the hint is text, not chrome).
- A second submit path (palette Ask ideas stay out; Composer remains the one input).
- Reasoning summaries in the transcript (rule 10/§22 stands).
- Signed/notarised builds (operations; the updater path stays wirable).
