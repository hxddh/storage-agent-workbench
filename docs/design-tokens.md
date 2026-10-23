# Design tokens

> **Storage Agent v14 — design system v8, one quiet workspace.**
>
> Presentation contract for the native Agent Task window. Tokens never invent
> runtime state, progress, or capabilities.

v8 is the quiet-workspace refinement. The window no longer presents storage as a
product object: there is no Storage page, bucket index, bucket sheet, estate
picker or open-Issue counter. Home is the same workspace before its first
Direction — one mark, one sentence, one Composer. A Task reads as one
conversation: objective, receipt, answer, findings, then deterministic data in
a fold. The Agent resolves accounts and buckets from the request; the estate
remains its memory.

The information hierarchy follows the current agent products rather than their
chrome: Codex's one task and one input, Cursor's compact tool rows and
click-to-inspect evidence, Qoder's single task monitor when needed. What we take
is restraint: one fixed rail, one workspace, one input, work shown as a trace,
the answer as a document, and data as a quiet fold. We do not take an IDE file
tree, a resource browser, task cards, a plan canvas, or a second navigation
tree.

## Source of truth

| Layer | File |
| --- | --- |
| CSS variables (colour, type, spacing, radius, shadow, motion, measure) | `frontend/src/index.css` |
| Tailwind mapping | `frontend/tailwind.config.js` |
| Component library (Button, IconButton, Kbd, Badge, StatusDot, Segmented, Field / TextInput / Select) | `frontend/src/components/ui.tsx` |
| Component styles (`ui-*`), menus, scrim, keyframes | `frontend/src/styles/components.css` |
| Window, sidebar, title bar, Composer, Home, Task workspace, Evidence, Settings | `frontend/src/styles/app.css` |
| Prose, tables, figures, toasts | `frontend/src/styles/document.css` |
| Rendered Markdown | `frontend/src/styles/markdown.css` |
| Figures (`ChartFrame`, marks, legend, tooltip) | `frontend/src/viz/marks.tsx` |
| Enforcement | `frontend/src/design-tokens.test.ts`, `frontend/src/theme.tokens.test.ts`, `frontend/src/contracts.test.ts`, `e2e/contrast.spec.ts` |

Both themes are first-class. **System** follows the OS and is the default until
the reader chooses Light or Dark. Every text step clears WCAG AA (4.5:1)
against `--hover`, the worst surface it can land on, and the rendered product is
audited text node by text node in both themes.

## The surface rule

The document is the product. A content section does not get a border, a radius,
a background, or a shadow. Hierarchy comes from:

1. **one accent** for action, selection, focus and live work;
2. **type** — 11 meta, 13 interface, 15 reading, 20 focal, 28 page title;
3. **space** — a 4 px grid with 16–32 px between content groups;
4. **hairlines** — one rule where two groups genuinely meet.

Only six things are surfaces: the Composer, menus/popovers, toasts, the side
pane, the Settings dialog, and code blocks. That is the whole elevation vocabulary.

## Colour

### Cool neutral ladder

Dark, darkest first:
`--canvas #0b0c0f` < `--sidebar #121419` < `--panel #17191f` <
`--elevated #1d2027` < `--hover #282c34`;
edges `--edge #22262e` / `--edge-strong #343a44`.

Light, warm paper:
`--canvas #fcfcfb`, `--sidebar #f3f4f5`, `--panel #f3f4f5`,
`--elevated #ffffff`, `--hover #e9eaec`;
edges `#e3e4e8` / `#d2d6de`.

Ink: `--gray-100` primary · `--gray-200` strong secondary · `--gray-300`
secondary · `--gray-400` tertiary · `--gray-500` meta (`#9197a3` dark /
`#5f6672` light). There is no 600/700
text step; quiet text stays readable.

The ladder is one cool hue axis in both themes. It is deliberately narrow: the
canvas and the rail are a step apart, not a card floating on a page.

### Accent — one blue

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--accent` | `#2f5fe3` | `#2557d6` | fill of the primary action, send, selected task |
| `--accent-soft` | `#2a55cc` | `#1f4ab8` | hover step of the fill |
| `--accent-fg` | `#ffffff` | `#ffffff` | label on an accent fill |
| `--accent-text` | `#93b4ff` | `#1d4ed8` | links, live progress, the working dot |
| `--accent-dim` | 14% tint | 8% tint | focus ring, selection tint |

Accent marks what is actionable, selected, focused or live — never decoration,
headings or status. There is one hue.

### Status

`--danger`, `--warn` / `--warn-fg`, `--success`, each with a `-bg` and a
`-border`. Status is a dot or a badge beside neutral text, never coloured prose
or a coloured figure. Findings use the status palette for the dot only.

### Figures and code

`--viz-1` … `--viz-6` are the categorical series, validated for CVD and
normal-vision separation in both themes. Text in a figure uses ink, never a
series colour. Code uses `--code-bg` plus the `--syn-*` slots; every slot clears
AA on the slab.

## Type

Five sizes, each with one job:

| Token | Size / leading | Use |
| --- | --- | --- |
| `--text-2xs` | 11px / 16px | labels, meta, key caps, badges |
| `--text-sm` | 13px / 20px | interface, sidebar, controls, secondary text |
| `--text-prose` | 15px / 1.65 | reading, answers, reports |
| `--text-xl` | 20px / 28px | a Turn's objective, the focal answer |
| `--text-2xl` | 28px / 36px | the page's one `<h1>` (Home) |

Faces: the platform UI face first (SF Pro on macOS, Segoe UI Variable on
Windows), vendored **Inter Variable** where the platform face is not a UI face,
and **JetBrains Mono Variable** for tool names, keys, payloads and code. CJK
falls through to the platform face. Rank comes from size, weight and space, not
from fading text or uppercase micro-labels. There are no uppercase section
labels in the window.

## Spacing, radius, elevation

Spacing is a 4 px grid: `--space-1` (4) · `-2` (8) · `-3` (12) · `-4` (16) ·
`-5` (20) · `-6` (24) · `-8` (32) · `-10` (40) · `-12` (48).

Radii are three: **6 px** controls · **8–10 px** menus and popovers · **14 px**
the Composer, side pane and Settings. The aliases `--radius-sm` … `--radius-3xl`
keep every surface on the same scale.

Shadows are two: `--shadow-elev` for menus and popovers, `--shadow-pop` for the
Settings dialog and the overlaid side pane. The Composer carries one hairline and a soft focus ring, never a drop shadow. The
canvas is flat.

Icons are 16 px (14 px in dense rows) at a 1.5 stroke with rounded joins.

## Measure and layout

`--doc-measure: 43rem` (688 px) is the reading column; `--doc-track: 60rem` is
the track for tables and figures. `--sidebar-w: 15.5rem` (248 px); the side pane
is resizable from 352 to 880 px and starts at 480 px. `--header-h: 2.5rem`
(40 px); `--control-h: 2rem` (32 px).

Home is an empty Task: one small Agent mark, one 28 px heading, the Composer
directly beneath it, and nothing else, centred as one block. There are no prompt
links, readiness paragraphs, cards, account lines, issue tables or connection
rows on Home.

The Task page is one conversation, oldest first. Each Turn is the objective,
one clickable receipt (`2 checks · 1s`), the answer, findings, then the
deterministic result in a **Data** fold beneath. The trace is open while live
(real calls and real progress; the running call is the head line, returned calls
follow) and becomes the receipt when settled. A fix's Data fold opens by default;
everything else waits. Deterministic results render from `tool_output.detail` as
part of the document: a table has a header rule and row rules, not a card. There
is no user/assistant bubble and no next-step prompt.

Evidence is the one side pane, one level: a meta line, one row per call (verb,
target, time, summary), which expands in place to a compact human result and its
arguments/output behind **Raw**; Save report, attached files and usage folded at
the foot. Opening a call from the live trace opens that call, not the top of a
long list. There is no second page and no Back control. The full table stays in
the task's Data fold.

## Components

`components/ui.tsx` is the only place a control's shape is decided; the look
lives in `styles/components.css`.

- `Button` (`ui-btn`, `data-variant`): one filled `primary` per surface;
  `secondary` is a hairline, `ghost` is text, `danger` is text in the danger ink.
- `IconButton` (`ui-icon-btn`): 26 px square; its label is the accessible name
  and tooltip.
- `Kbd` (`ui-kbd`): one quiet cap per key.
- `Badge` / `StatusDot`: tone by meaning; the dot pulses only while work is live.
- `Segmented` (`ui-segmented`): a 2 px inset track, not a row of pills.
- `Field` + `TextInput` / `Select`: 32 px, one hairline, focus is one blue ring.

The Composer is the only Agent input: centred on Home, docked at the foot of a
task. Its border is neutral at rest and on focus; there is no glow. The send
control is a small accent circle only when ready. Three controls at rest: the
paperclip (attach a file), the model chip and Send. There is no estate picker;
the Agent resolves account and bucket names from the request. The model chip is
a text control, not a pill.

## Motion

| Token | Value | Use |
| --- | --- | --- |
| `--duration-fast` | 120ms | hover, controls, chrome |
| `--duration-base` | 200ms | menus, view transitions |
| `--duration-slow` | 280ms | sheets, dialogs, the side pane, sidebar collapse |
| `--duration-instant` | 120ms | alias of fast |

Easing: `--ease-out` `cubic-bezier(0.2, 0.8, 0.2, 1)`, `--ease-emphasized`
`cubic-bezier(0.3, 0, 0, 1)`, `--ease-in-out` for cycles.

`prefers-reduced-motion` zeros animation and transition durations, stops the
pulsing dot, and leaves opaque surfaces static. Content does not slide in on
every render; a settled answer is simply there.

## Keyboard and focus

Focus is a 2 px `--focus-ring` outside a 1 px canvas gap, following the
element's own radius. Opt out only with `data-focus-ring="container"` when an
ancestor already draws the ring (the Composer does).

**⌘K / Ctrl+K focuses the sidebar title search.** There is no command palette.
Esc clears the search. ↑/↓ move between task rows. ⌘N starts a new task, ⌘,
opens Settings, ⌘I opens or closes the side pane, ⌘B / ⌘\ toggles the sidebar,
and ⌘. stops live work.

## Non-goals

Tokens must not imply a second Agent, a synthetic plan or stepper, an approval
pause, a status bar, a permanent inspector column, a card per content block, a
storage resource browser or a second presentation lifecycle. The accent never
signals status; status colours never mark series or decoration. The side pane is
the one place a Task's raw Evidence opens.
