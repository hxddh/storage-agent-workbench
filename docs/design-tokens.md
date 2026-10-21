# Design tokens

> **Storage Agent v12 — design system v6, one article.**
>
> Presentation contract for the native Agent Task window. Tokens never invent
> runtime state, progress, or capabilities.

v6 is a subtraction pass after the v11 release review. The window had drifted
into boxes: a glowing Composer, a bordered row per finding, a full-width card
per suggestion, boxed notes, boxed issue rows, an inspector of uppercase labels,
and a warm-paper palette that fought the blue live state. v6 keeps one surface —
the document — and lets typography and hairlines carry hierarchy.

The information hierarchy follows the current agent products rather than their
chrome: Codex's one document and bottom Composer, Cursor's inline context and
compact tool rows, Qoder's single conversation plus one task monitor. What we
take is restraint: one fixed rail, one reading column, one input, work shown as
a trace and results shown as a document. We do not take an IDE file tree, task
cards, a plan canvas, or a second navigation tree.

## Source of truth

| Layer | File |
| --- | --- |
| CSS variables (colour, type, spacing, radius, shadow, motion, measure) | `frontend/src/index.css` |
| Tailwind mapping | `frontend/tailwind.config.js` |
| Component library (Button, IconButton, Kbd, Badge, StatusDot, Segmented, Field / TextInput / Select) | `frontend/src/components/ui.tsx` |
| Component styles (`ui-*`), menus, scrim, keyframes | `frontend/src/styles/components.css` |
| Window, sidebar, title bar, Composer, home, Task page, side pane, Settings, Quick Ask | `frontend/src/styles/app.css` |
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
2. **type** — 11 meta, 13 interface, 15 reading, 20 focal, 24 page title;
3. **space** — a 4 px grid with 16–32 px between content groups;
4. **hairlines** — one rule where two groups genuinely meet.

Only six things are surfaces: the Composer, menus/popovers, toasts, the side
pane, the Settings dialog, and code blocks. That is the whole elevation vocabulary.

## Colour

### Cool neutral ladder

Dark, darkest first:
`--canvas #090a0c` < `--sidebar #12141a` < `--panel #171a20` <
`--elevated #1e2128` < `--hover #292d35`;
edges `--edge #23262d` / `--edge-strong #343841`.

Light, clean white:
`--canvas #ffffff`, `--sidebar #f5f6f8`, `--panel #f4f5f8`,
`--elevated #ffffff`, `--hover #e9ebef`;
edges `#e4e6eb` / `#d2d6de`. The user's message has its own `--bubble`
(`#1b1e24` dark, `#f1f3f6` light).

Ink: `--gray-100` primary · `--gray-200` strong secondary · `--gray-300`
secondary · `--gray-400` tertiary · `--gray-500` meta. There is no 600/700
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
| `--text-sm` | 13px / 20px | interface, sidebar, controls, prompt links |
| `--text-prose` | 15px / 1.65 | reading, answers, reports |
| `--text-xl` | 20px / 28px | a conclusion's focal answer |
| `--text-2xl` | 24px / 32px | the page's one `<h1>` (Home) |

Faces: the platform UI face first (SF Pro on macOS, Segoe UI Variable on
Windows), vendored **Inter Variable** where the platform face is not a UI face,
and **JetBrains Mono Variable** for tool names, keys, payloads and code. CJK
falls through to the platform face. Rank comes from size, weight and space, not
from fading text or uppercase micro-labels. There are no uppercase section
labels in the window.

## Spacing, radius, elevation

Spacing is a 4 px grid: `--space-1` (4) · `-2` (8) · `-3` (12) · `-4` (16) ·
`-5` (20) · `-6` (24) · `-8` (32) · `-10` (40) · `-12` (48).

Radii are three: **6 px** controls · **8 px** menus · **12 px** the Composer,
side pane and Settings. The aliases `--radius-sm` … `--radius-3xl` keep every
surface on the same scale.

Shadows are two: `--shadow-elev` for menus and popovers, `--shadow-pop` for the
Settings dialog and the overlaid side pane. The Composer has no shadow. The
canvas is flat.

Icons are 16 px (14 px in dense rows) at a 1.5 stroke with rounded joins.

## Measure and layout

`--doc-measure: 44rem` (704 px) is the reading column; `--doc-track: 60rem` is
the track for tables and figures. `--sidebar-w: 15rem` (240 px); the side pane
is resizable from 352 to 880 px and starts at 480 px. `--header-h: 2.75rem`
(44 px); `--control-h: 2rem` (32 px).

Home is an empty Task, not a landing page: one 24 px heading, three prompt
**text links** separated by a dot on first run only (stacked below 720 px), one
readiness line, then the estate's attention and account lines, and the same
docked Composer as every task. The content is centred in the document above the
dock; a short home is balanced rather than pinned to the top. Nothing on Home
submits work except the Composer.

The Task page is request → **one assistant article**: receipt → answer →
rendered result → findings → one next step. The trace is open while live (real
calls and real progress below it) and becomes one quiet receipt when settled; the
receipt does not expand. Deterministic results render from `tool_output.detail`
as part of the document: a table has a header rule and row rules, not a card.
Findings are a flat list with a severity dot and no evidence line: the title
bar's Evidence is the one entry to the calls. At most the first recorded next
step appears, as a text line, never a row of cards.

Evidence is the one side pane, one level: a human heading, one row per call
(verb, target, time, summary), which expands in place to the rendered result and
raw data; Save report, attached files and usage folded at the foot. There is no
second page and no Back control. It is not an inspector of uppercase labels.

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

The Composer is the only Agent input, docked at the same position on Home and
every task. Its border is neutral at rest and on focus; there is no glow. The
send control is a small accent circle only when ready. Three controls at rest:
the `+` menu (Attach a file · Add estate context), the model chip and Send; a
context picker opened from the menu draws its focus ring on the popover, not as
a second box around the search field. The model chip is a text control, not a
pill. Selected context reads as a 24 px text token on `--hover`, not a bordered
card.

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
pause, a status bar, a permanent inspector column, a card per content block, or
a second presentation lifecycle. The accent never signals status; status colours
never mark series or decoration. The side pane is the one place a Task's durable
outputs open.
