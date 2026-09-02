> **Historical.** This is a v1.04-era review note kept for the record. It is superseded by the v1.09.0 native Agent window and the v1.10.0 native shell; see `docs/README.md` for the current documents.

# Modern Native Agent — Deep Review 2026-09-01

> **Verdict on v1.04.1**: The *runtime* is modern (durable `task_executions` + `execution_events` at `after=<seq>`, typed `task_context_versions`, single orange voltage). The *shell* is not. The rebuild so far was warm paint on a web-app chassis. Codex and Cursor do not look like that.

## 1. What Codex / Cursor actually are

**Cursor** is not an editor with an AI panel. It is an **AI-first IDE** whose layout is `Activity Bar (56px) | Explorer (260px, collapsible) | Editor (flex, 46rem prose) | Inspector (240px, native) | Status Bar (22px)` — all hairline, all keyboard-first. The marketing canvas is warm cream ` #f7f7f4` on ` #26251e`, but the *editor* is cool, technical, and dense. The hierarchy is `weight 400` display at `-0.02em`, not bold. Cards float on `1px` borders, never shadows. The primary action is a single orange ` #f54e00` pill. Everything else is surface + weight.

**Codex (OpenAI, 2025-26)** is a **terminal-native agent**: a single, sticky, 44px chat input at the bottom of a 46rem document, with a live trace that grows in place and a `J/K` that walks *Direction* blocks by writing `scrollTop` (not `scrollIntoView`). The empty state is the Composer. There is no header, no status strip, no second presentation mode. The product is a document that streams.

**Both share:** one accent voltage, hairline-only depth, weight-400 display, iOS spring (`0.16,1,0.3,1` 120/180/240), and the invariant that *the task document is the product, not the chrome around it*.

## 2. What v1.04.1 still gets wrong (honest)

### Runtime — 80% modern, 20% web-app residue

| Gap | Why it is not Codex/Cursor native | Fix |
|---|---|---|
| **No sub-agent fanout** | `_MAX_PARALLEL_TOOLS=6` is a concurrency cap inside one step, not a fanout. A real investigation that needs `survey_account` across 96 buckets still pays 96 serial `head_bucket` calls or one bulk `survey_account` that cannot be steered mid-flight. Cursor fans `head_object` in parallel sub-agents that can be steered/cancelled per shard. | Gated `ReadOnlySubAgent(task_id, bucket_shard)` that shares `SteerQueue` + `budget_tokens`, merges as one `tool.completed` per shard. No new UI, just faster. |
| **Skills are markdown, not tools** | `read_skill` returns guidance text. The agent must still *decide* to call `list_objects`. Cursor's skill is a *tool* that is executed, not read. Our skills need an `onRead` that pre-loads the relevant tool group (`load_tools("bucket_config")`) so the next step is not a round-trip. | `read_skill` → `load_skill(name)` that both returns the method *and* unlocks the gated group. |
| **Observability is a dump, not a trace** | `GET /export/otel` returns JSON. Cursor's trace is an **OTel span** that can be opened in Jaeger. Our export should be `traceparent` + `span_id` per `execution_events` row. | Add `trace_id`/`span_id` to `execution_events`, emit W3C `traceparent`. |
| **No real-time collaboration** | One local vault, one SQLite. Cursor has real-time threads that can be shared. Not a priority for local-first, but the *absence* should be explicit. | Document as non-goal, not as a missing feature. |

### UI — still a web app in a Tauri window

| Gap | Current v1.04.1 | Codex/Cursor native | Cost if not fixed |
|---|---|---|---|
| **Chrome is painted, not native** | Top bar is a `div` with `data-tauri-drag-region`, but the traffic lights are not native, the title is centered, and the bar is `h-7` with a 1px border. Codex uses `titleBarStyle: overlay` with `vibrancy` and the title is left-aligned, 13px semibold. | Users read it as a web app in a window. | High — the first 200ms impression. |
| **Icon Bar is an afterthought** | 56px bar with 4 icons, but the icons are `strokeWidth 1.7` generic outlines, not Cursor's filled, optical, 16px icons with a 2px selected indicator. The bar has `gap-1` and `py-2`, but Cursor's has `gap-0` and `py-1` with a 32px hit target and a 2px left accent for the selected item. | The bar looks like a toolbar, not an activity bar. | Medium — the bar is the user's home. |
| **Explorer is a list, not a tree** | `AgentTaskNavigation` is a flat chronological list with `Rename/Delete` only. Cursor's explorer is a *tree* with search, pin, and a `⌘P` quick open. Our list is correct for the product (one chronological list, rename+delete only) but it is also *inefficient* at 30+ tasks: it has no search, no filter, no keyboard type-ahead. | The user pays `O(n)` to find a task. | High — the product *is* the task list. |
| **Composer is still a form** | 44px `rounded-2xl` with `px-4/py-3.5`, `text-base`, orange pill. It is better than v1.02's `32px` pill, but it is still a *form* with a textarea + two buttons. Cursor's chat is a *single* `contenteditable` that grows from 44px to 240px, with `↑/↓` history, `⌘K` to reference files, and `⇧Enter` for newline. Our `Enter` to send, `Shift+Enter` for newline is correct, but the affordance is not: the paperclip is `h-8 w-8` with a border, not a `h-7 w-7` ghost, and the `Delegate` pill has a send icon that is `opacity-80` and `strokeWidth 2` — too heavy. | The Composer is the product's only input. If it feels like a form, the product feels like a form. | Critical |
| **Work Result is a card, not a page** | `46rem` card with `rounded-xl border-edge shadow-elev px-5 py-5` and a `7×7` orange star. It is better than the old chat bubble, but it is still a *card* in a *canvas*. Codex's Work Result is a *page*: `46rem` of `prose` with `1.8` leading, `h2` at `19px weight 400 tracking -0.02em`, `h3` at `16px`, `code` at `93%` JetBrains Mono, tables that are `min(46rem,100%)` with `tabular-nums`, and `wide` tables that break out to `64rem` but share the left edge. Our card's `px-5` indents the prose's left edge by `1.25rem` from the document's left edge, so the test `wideLeft - proseLeft <=1` fails (it did, and we fixed it by making the outer `64rem`, but the inner `px-5` still indents). | The Work Result does not read as a technical paper. | High |
| **Details is a placeholder** | 240px `Inspector` with `Task / Shortcuts / Model` — three static sections, no contextual content. Cursor's right pane is *contextual*: when a tool call is selected, it shows the call's input/output; when a file is referenced, it shows the file. Our `ExecutionReview` and `EvidenceReview` are still overlays, not an inspector. | The right pane is wasted space. | Medium |
| **Typography is not editorial** | Inter at `letter-spacing -0.011em` for body, `-0.02em` for display, `font-feature-settings "cv05" "cv11" "ss03"`. It is correct but it is also *generic*: every AI tool uses Inter. Cursor uses `CursorGothic` for display and `JetBrains Mono` for code, with a clear distinction between *interface* (13px `sm`), *prose* (15px `prose` at 1.8), and *display* (23px `2xl` at 400). Our scale is still `2xs/xs/sm/prose/base/lg/xl/2xl` — 8 steps, but the *use* is not editorial: `h2` is still `14px` in many places, `h3` is `13px`, and `prose` is `15px` — the hierarchy is flat. | The document has no voice. | High |
| **Motion is web, not native** | `ease-out cubic-bezier(0.21, 0.6, 0.35, 1)` 140/200/280. iOS spring is `0.16,1,0.3,1` 120/180/240, but our Composer still fades in with `translateY(4px)` and the Review scales `98→100`. Native motion is *spring* with *mass* and *damping*, not bezier. Codex uses `framer-motion` spring `stiffness 500 damping 40`. | The app feels like a website. | Medium |
| **Density is wrong** | The empty state is `No tasks yet` with `text-xs` and `text-2xs` metadata. Cursor's empty state is a *magazine* empty state: a 72px hero at `weight 400 -2.16px`, a 16px sub, and a 14px CTA. Our empty state is a *settings* empty state. | The first 30 seconds feel empty. | Medium |

### UE — still O(n) where it should be O(1)

- **Task switching is `click`**, not `⌘K` + fuzzy. The palette exists but it is not the *primary* way to switch tasks; the sidebar is. Cursor's `⌘K` is the primary. Our `⌘K` is a secondary.
- **No `J/K` preview**. Cursor shows a preview of the task on hover/focus in the palette. Our `j/k` walks the document, not the list.
- **No `⌘B`/`⌘.` muscle memory**. The shortcuts exist but they are not *taught*: there is no `kbd` in the UI, no `ShortcutsSheet` that is discoverable. The user has to read `docs/keybindings.md`.
- **The Composer has no history**. Cursor's `↑` recalls the last prompt. Our Composer does not.
- **The Work Result has no outline**. Codex's long Work Results have a `nav[data-testid="answer-outline"]` that is `grid 2×`. Our outline is there but it is not *sticky* and it is not *collapsible*.

## 3. The rebuild that is not a tweak

A tweak would be to change the hue from 268 to 32 (we did) and to add an icon bar (we did). A rebuild is to **remove the web-app chassis** and replace it with a native document.

**What to delete:**

- The `box-shadow` elevation on every card. Native depth is a hairline and a surface step, not a shadow. The current `--shadow-elev` as `0 0 0 1px var(--edge)` is correct, but it is still *used* as a shadow on the Work Result card. It should be a border, not a shadow.
- The `font-weight: 700` on every heading. Display should be `400` with `-0.02em`.
- The `rounded-xl` on the Work Result card. A native document has `rounded-lg` for cards, `rounded-md` for controls, `rounded-full` for pills. `rounded-xl` is a marketing card, not a document.
- The `transition-all` on every interactive element. Only `transform`, `opacity`, `background-color`, `border-color` should transition.

**What to build:**

- A **native title bar** with `titleBarStyle: overlay` and `vibrancy: sidebar`, 28px, `data-tauri-drag-region`, traffic lights inset 12px, title `13px semibold tracking -0.01em`, window controls on the left (macOS) with `12px` hit target.
- An **activity bar** that is `44px` (not 56px), with `32px` hit targets, `1.5px` selected indicator on the left, `8px` gap, `py-1`, and `16px` optical icons (filled when selected, outline when not).
- An **explorer** that is a *tree* with `8px` row height `28px`, `12px` `sm` type, `6px` `px-2`, `4px` `gap-1`, and a `⌘K` quick open that is the *primary* way to switch. The list remains chronological, but it has `type-ahead` and `fuzzy` via the palette.
- A **document** that is `46rem` of `15px/1.8` `Inter` with `JetBrains Mono` at `93%`, `h2` `19px/400/-0.02em`, `h3` `16px/500/-0.01em`, `code` `13px`, tables `13px tabular-nums` with `min(46rem,100%)` prose and `64rem` wide, and a `sticky` outline.
- A **composer** that is a single `contenteditable` (not a `textarea`) that grows `44px → 240px`, with `↑` history, `⌘K` file reference, `⇧Enter` newline, and a single `↵` Delegate that is `32px` with `13px` `medium` and `0.01em` tracking.
- An **inspector** that is `280px` (not 240px), with `12px` `sm` type, `8px` `p-3`, `6px` `gap-2`, and *contextual* content: when a tool is selected, it shows `CallDetail`; when a finding is selected, it shows `EvidenceActivity`.

This is not a tweak. It is a rebuild.
