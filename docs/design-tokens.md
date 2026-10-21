# Design tokens

> **Storage Agent v11 — design system v5, the run made legible.**
>
> Presentation contract for the native Agent Task window. Tokens never invent
> runtime state, progress, or capabilities.

v5 keeps **warm graphite and paper, one ink-blue accent** and the same five-size
scale, and subtracts the editorial layer: Home is an empty Task, the Composer is
docked in one place, and the run trace/result/evidence replace the old
landing-page and developer-inspector chrome. The product is still one window: a
sidebar, a title bar, one conversation, one Composer, and one side pane.
Controls come from the component library; components do not invent raw colours,
arbitrary type sizes, radii, or transitions.

Both themes are first-class. A third preference, **System**, follows the OS and
is the default until the reader chooses Light or Dark.

## Source of truth

| Layer | File |
| --- | --- |
| CSS variables (colour, type, spacing, radius, shadow, motion, measure) | `frontend/src/index.css` |
| Tailwind mapping | `frontend/tailwind.config.js` |
| Component library (Button, IconButton, Kbd, Badge, StatusDot, Segmented, Field / TextInput / Select) | `frontend/src/components/ui.tsx` |
| Component styles (`ui-*`), menus, scrim, the `ui-pop-in` / `ui-pulse` keyframes | `frontend/src/styles/components.css` |
| Window, sidebar, title bar, Composer, home, Task page, side pane, Settings, Quick Ask, motion | `frontend/src/styles/app.css` |
| Prose, tables, figures, toasts, the `reveal-in` keyframe | `frontend/src/styles/document.css` |
| Rendered Markdown | `frontend/src/styles/markdown.css` |
| Figures (`ChartFrame`, marks, legend, tooltip) | `frontend/src/viz/marks.tsx` |
| Enforcement | `frontend/src/design-tokens.test.ts`, `frontend/src/theme.tokens.test.ts`, `frontend/src/theme.test.tsx`, `frontend/src/contracts.test.ts`, `e2e/contrast.spec.ts` |

Every text step clears WCAG AA (4.5:1) against `--hover`, the worst surface it
can land on, and the rendered product is audited text node by text node in both
themes.

## Colour

### Warm neutral ladder

Dark surfaces, darkest first:
`--canvas #12110e` < `--sidebar #1a1814` < `--panel #201c18` <
`--elevated #2a261f` < `--hover #353028`;
edges `--edge #2d2922`, `--edge-strong #403a30`.

Light surfaces (paper, not white):
`--canvas #f2eee5`, `--sidebar #e9e4d9`, `--panel #f9f6f0`,
`--elevated #ffffff`, `--hover #e0d9cb`, edges `#ddd6c9` / `#c9c0b1`.
The user's message has its own `--bubble` (`#2b2720` dark, `#ebe5d9` light).

Ink: `--gray-100` primary · `--gray-200` strong secondary · `--gray-300`
secondary · `--gray-400` tertiary · `--gray-500` meta. There is no 600/700
text step; quiet text stays readable.

### Accent — ink blue, one hue

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--accent` | `#5964dc` | `#3f4ecf` | fill of the primary action, Composer send |
| `--accent-soft` | `#6570e4` | `#3443c0` | hover step of the fill |
| `--accent-fg` | `#ffffff` | `#ffffff` | label on an accent fill |
| `--accent-text` | `#b3baff` | `#3543b8` | links, live progress, the working dot, accent icons |
| `--accent-dim` | 16% tint | 9% tint | selection, active rows, tinted icon wells |

`--focus-ring` and `--selection` derive from the same hue. Accent marks what is
actionable, selected, focused or live — never decoration, headings or status.

### Status

`--danger`, `--warn` / `--warn-fg`, `--success`, each with a `-bg` and
`-border`. Status is carried by a dot or a badge beside neutral text, never by
coloured prose or a coloured figure. High / medium / low / info findings use
the status palette for their dot only.

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
| `--text-sm` | 13px / 20px | interface, sidebar, controls, tool rows |
| `--text-prose` | 15px / 1.7 | reading, answers, reports |
| `--text-xl` | 20px / 28px | a conclusion's focal answer |
| `--text-2xl` | 28px / 36px | the page's one `<h1>` (Home) |

Faces: the platform UI face first (SF Pro on macOS, Segoe UI Variable on
Windows), vendored **Inter Variable** where the platform face is not a UI face,
and **JetBrains Mono Variable** for tool names, keys, payloads and code. CJK
falls through to the platform face. Rank comes from size, weight and space, not
from fading text.

## Spacing, radius, elevation

Spacing is a 4px grid: `--space-1` (4) · `-2` (8) · `-3` (12) · `-4` (16) ·
`-5` (20) · `-6` (24) · `-8` (32) · `-10` (40) · `-12` (48).

Radii are three: **6px** small controls · **8px** surfaces and menus · **12px**
the Composer and side pane. The aliases `--radius-sm` … `--radius-3xl` keep
every surface on the same scale.

Shadows are two: `--shadow-elev` for menus and popovers, `--shadow-pop` for
dialogs and the overlaid side pane. The canvas is flat; depth comes from
hairline separators and surface steps, not a stack of cards or an ambient wash.

Icons are 16px (14px in dense rows) at a 1.5 stroke with rounded joins.

## Measure and layout

`--doc-measure: 46rem` is the reading column; `--doc-track: 64rem` is the track
for tables and figure cards. `--sidebar-w: 17rem`; the side pane is resizable
from 352 to 880px and starts at 420px. `--header-h: 3rem`; `--control-h: 2rem`.

Home is an empty Task, not an editorial start surface: one 28px heading, three
quiet prompt chips, the estate's attention and account lines, and the same
docked Composer as every task. There is no eyebrow, hero, starter card or
separate estate page.

The Task page is request → **run trace** → rendered result → answer → findings.
The trace is open while work is live (one row per real call, real progress) and
becomes a receipt when settled; its result view renders `tool_output.detail`
deterministically. Findings carry a quiet checks chip that opens Evidence, or
*No direct check*. Evidence is the one side pane: a human heading, one row per
call, rendered result first and raw JSON behind a fold.

## Components

`components/ui.tsx` is the only place a control's shape is decided; the look
lives in `styles/components.css`.

- `Button` (`ui-btn`, `data-variant`): `primary` (accent fill, one per
  surface), `secondary` (raised neutral), `ghost`, `danger`; sizes `sm` / `md`.
- `IconButton` (`ui-icon-btn`): square; its label is the accessible name and
  tooltip.
- `Kbd` (`ui-kbd`): one cap per key.
- `Badge` / `StatusDot`: tone by meaning; the dot pulses only while work is
  live.
- `Segmented` (`ui-segmented`), `Field` + `TextInput` / `Select`.

The Composer is the only Agent input, docked at the same position on Home and
every task. Its send control is a round accent button when ready; the model
chip names the real active model and opens the real provider list; `@` opens one
searchable estate picker and selected refs read as chips. The save row in
Settings is a pinned toolbar above the fields, so it stays in reach without
covering a credential field.

## Motion

| Token | Value | Use |
| --- | --- | --- |
| `--duration-fast` | 120ms | hover, controls, chrome |
| `--duration-base` | 200ms | menus, reveal, the progress hairline |
| `--duration-slow` | 280ms | sheets, dialogs, the side pane, sidebar collapse |
| `--duration-instant` | 120ms | alias of fast |

Easing: `--ease-out` `cubic-bezier(0.2, 0.8, 0.2, 1)`, `--ease-emphasized`
`cubic-bezier(0.3, 0, 0, 1)`, `--ease-in-out` for cycles.

`prefers-reduced-motion` zeros animation and transition durations, stops the
pulsing dot and the progress hairline, and leaves opaque surfaces static.
Loading uses skeletons, not spinners. Live work is a pulsing dot with a real
elapsed timer. The only determinate meter is one whose counts the runtime
reported, never a time estimate.

## Keyboard and focus

Focus is a 2px `--focus-ring` outside a 1px canvas gap, following the
element's own radius. Opt out only with `data-focus-ring="container"` when an
ancestor already draws the ring (the Composer does).

**⌘K / Ctrl+K focuses the sidebar title search.** There is no command palette.
Esc clears the search. ↑/↓ move between task rows. ⌘N starts a new task, ⌘,
opens Settings, ⌘I opens or closes the side pane, ⌘B / ⌘\ toggles the sidebar,
and ⌘. stops live work.

## Non-goals

Tokens must not imply a second Agent, a synthetic plan or stepper, an approval
pause, a status bar, a permanent inspector column, or a second presentation
lifecycle. The accent never signals status; status colours never mark series or
decoration. The side pane is the one place a Task's durable outputs open.
