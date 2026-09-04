# Design tokens

> **Storage Agent v1.17.3.** Presentation contract for the native Agent
> window. Tokens do not invent runtime state, progress, or capabilities.

v1.09 replaces the v1.04–v1.08 warm/orange system with one achromatic surface
ladder and an ink primary. Components must not introduce ad-hoc px font sizes,
corner radii, z-index numbers, or `transition-all`.

## Source of truth

| Layer | File |
| --- | --- |
| CSS variables (color, type, radius, motion, shadow, measure) | `frontend/src/index.css` |
| Tailwind mapping | `frontend/tailwind.config.js` |
| Window, sidebar, title bar, Artifacts panel | `frontend/src/agent/native-shell.css` |
| Transcript turn, Composer, approval card, banners | `frontend/src/agent/native-document.css` |
| Enforcement | `frontend/src/design-tokens.test.ts`, `frontend/src/theme.tokens.test.ts`, `frontend/src/agent/architecture.test.ts` |

Both themes are first-class. Dark is the default; light is not an inversion of
foregrounds on a white page. Neighbouring surfaces stay at least 2.5 CIE L*
apart and the ladder spans at least 12 L*; every ink step (`--gray-100` …
`--gray-500`) clears WCAG AA (4.5:1) against `--hover`, the worst ground text
can land on.

## Color

Surfaces (achromatic, dark → light in the dark theme):
`--canvas #0f0f0f` < `--sidebar #181818` < `--panel #1f1f1f` < `--elevated #292929` < `--hover #333333`;
edges `--edge #2a2a2a`, `--edge-strong #3d3d3d`. Light mirrors the ladder from `#ffffff` down to `#dadada`.

Ink: `--gray-100` strongest … `--gray-500` faintest. No `--gray-600/700`.

Primary: `--accent` is **ink**, not a hue — `#ececec` on dark, `#0d0d0d` on
light — with `--accent-fg` the opposing canvas. Filled controls (send, Allow,
primary buttons) are the only places it is used as a fill. `--accent-soft` is
the hover step; `--accent-dim` a faint tint.

Status is the only colour: `--danger` / `--warn` / `--success` with matching
`-bg` and `-border`; `--warn-fg` for warning text. Working is not a colour: it
is the pulsing `.working-mark` and the `.working-shimmer` label.

Code: `--code-bg` plus `--syn-*` slots, AA against the slab in both themes.
Figures: `--viz-1` … `--viz-6` for discrete series; `--viz-1` is the one blue
in the system and exists for charts only.

Never use a raw `red-950` (or similar) palette step. Status meaning is a token.

## Type

| Token | Size | Use |
| --- | --- | --- |
| `--text-2xs` | 11px | meta, keycaps, chips |
| `--text-xs` | 12px | secondary chrome, tool rows |
| `--text-sm` | 13px | sidebar rows, title bar, controls |
| `--text-base` | 14px | Direction, Composer input |
| `--text-prose` | 15px / 1.75 | Work Result, Evidence, Report reading |
| `--text-lg` | 16px | section titles (Settings) |
| `--text-xl` | 19px | headings |
| `--text-2xl` | 24px / 400 | the empty-start greeting |

Faces: **Inter Variable** for UI and prose, **JetBrains Mono Variable** (93%
size-adjusted) for tool names, keys, payloads, and code. CJK falls through to
the platform face. Rank comes from size, weight, and space — not from fading
text. Display weight is 400–500; nothing in chrome is bold.

## Measure and layout

`--doc-measure: 46rem` is the reading column for Direction, prose, figures,
Decision cards and banners. `--doc-track: 64rem` is the document track: tables,
code fences and other data may use it and share the left edge
(`.agent-result-prose > .agent-result-wide`). `--sidebar-w: 16.25rem` is the
default sidebar; `--header-h: 2.25rem` the title bar and chrome rows;
`--control-h: 2rem` controls.

The window is `sidebar · title bar · document`. Depth is a hairline
(`--shadow-elev`), never a drop shadow; popovers use `--shadow-pop`.

## Spacing, radius

Spacing follows the Tailwind 4px rhythm (`--space-1` … `--space-8`).
Radius: `--radius-sm` (3px) through `--radius-2xl` (16px, dialogs) and
`--radius-3xl` (24px, the Composer). Chips and round controls are `full`.

## Motion

| Token | Value | Use |
| --- | --- | --- |
| `--duration-instant` | 70ms | hover color |
| `--duration-fast` | 120ms | chrome, controls |
| `--duration-base` | 180ms | dialogs, palette, scrim |
| `--duration-slow` | 240ms | Artifacts panel, sidebar collapse |

Easing is one spring-like curve, `cubic-bezier(0.16, 1, 0.3, 1)` (`--ease-out`
/ `--ease-emphasized`); `--ease-in-out` for cycles. Only `background`,
`border`, `color`, `transform`, `opacity`, `width` transition.
`prefers-reduced-motion` zeros animation and transition duration and replaces
skeletons/pulses/shimmer with static surfaces.

Loading uses **skeletons**, not spinners. In-flight tool rows use the
`.working-mark` pulse and the *Working* shimmer, which is real activity — not a
fake progress bar.

## Keyboard and focus

Visible `:focus-visible` ring follows the element's own radius. Opt out only
with `data-focus-ring="container"` when an ancestor already draws the ring
(Composer textarea). ⌘K / Ctrl+K is an overlay, not a destination. Palette
actions: new task, focus composer, Stop, Steer, Resume, settings, theme,
language, and task switch — only runtime-true work.

## Non-goals

Tokens must not be used to imply a second Agent, a synthetic plan/stepper, a
status bar, an inspector column, or a second presentation lifecycle. The
Artifacts panel is a quiet list of durable referents and one document at a time.
