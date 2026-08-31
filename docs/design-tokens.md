# Design tokens

> **Storage Agent v1.01.0.** Presentation contract. Tokens do not invent
> runtime state, progress, or capabilities.

v0.98 added `--viz-*` series colors on the v0.97 token system so deterministic
figures share dark/light with the rest of the product. v1.01 does not add
tokens; it reconstructs the Agent window. Components must not introduce ad-hoc px font
sizes, corner radii, z-index numbers, or `transition-all`.

## Source of truth

| Layer | File |
| --- | --- |
| CSS variables (color, type, radius, motion, shadow) | `frontend/src/index.css` |
| Tailwind mapping | `frontend/tailwind.config.js` |
| Enforcement | `frontend/src/design-tokens.test.ts`, `frontend/src/theme.tokens.test.ts` |

Both themes are first-class. Dark is the default; light is not an inversion of
foregrounds on a white page. Neighbouring surfaces must stay at least 2.5 CIE
L* apart; every ink step (`--gray-100`…`--gray-500`) must clear WCAG AA (4.5:1)
against `--hover`, the worst ground text can land on.

## Type

| Token | Size | Use |
| --- | --- | --- |
| `--text-2xs` | 11px | badges, keycaps, meta |
| `--text-xs` | 12px | secondary chrome |
| `--text-sm` | 13px | dense UI |
| `--text-base` | 14px | emphasis |
| `--text-prose` | 15px | Work Result / report reading |
| `--text-lg` | 16px | section titles |
| `--text-xl` | 19px | headings |
| `--text-2xl` | 23px | display |

Faces: **Inter Variable** for UI and prose, **JetBrains Mono Variable** for
keys, payloads, and code (optically size-adjusted). CJK falls through to the
platform face. Rank comes from size, weight, and space — not from fading text.

Work Result prose stays on a 46rem reading measure. Tables, charts, and code
fences may use the full task track and share the same left edge. Figures sit
inline in that document — there is no sticky figures rail and no third column.

## Color

Surfaces: `--canvas` < `--sidebar` / `--panel` < `--elevated` < `--hover`.
Accent: `--accent`, `--accent-soft`, `--accent-dim`, `--accent-fg`.
Status: `--danger` / `--warn` / `--success` with matching `-bg` and `-border`.
Code: `--code-bg` plus `--syn-*` slots, AA against the slab in both themes.
Figures: `--viz-1`…`--viz-6` for discrete series (class mix, cost columns).
They track accent/success/warn/gray so charts follow the theme. Never interpolate
a missing series with a made-up color or a made-up value.

Never use a raw `red-950` (or similar) palette step. Status meaning is a token.

## Spacing, radius, elevation

Spacing follows the Tailwind 4px rhythm (`--space-1`…`--space-8`).
Radius: `--radius-sm` (3px) through `--radius-3xl` (22px composer).
Elevation: `--shadow-elev`, `--shadow-pop`, `--shadow-glow` — theme-aware, not
hardcoded dark scrims. Control height `--control-h` (32px); header `--header-h`.

## Motion

| Token | Value | Use |
| --- | --- | --- |
| `--duration-instant` | 80ms | hover color |
| `--duration-fast` | 140ms | chrome, composer morph |
| `--duration-base` | 200ms | overlays |
| `--duration-slow` | 280ms | review panel, enter |

Easing: `--ease-out` (enter), `--ease-emphasized` (intentional), `--ease-in-out`
(cycles). `prefers-reduced-motion` zeros animation and transition duration and
replaces skeletons/pulses with static surfaces.

Loading uses **skeletons**, not spinners. In-flight tool rows use the
`.working-mark` pulse, which is real activity — not a fake progress bar.

## Keyboard and focus

Visible `:focus-visible` ring follows the element's own radius. Opt out only
with `data-focus-ring="container"` when an ancestor already draws the ring
(Composer textarea). ⌘K / Ctrl+K is an overlay, not a destination. Palette
actions: new task, Steer (focus composer while working), Stop, Resume, theme, language, and task switch — only runtime-true work.

## Non-goals

Tokens must not be used to imply a second Agent, a synthetic plan/stepper, or
a second presentation lifecycle. Overlay Review is title + close + artifact.
