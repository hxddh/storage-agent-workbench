/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Layered surfaces (deepest → most elevated). Theme-driven via CSS vars
        // defined in index.css (dark default + light override).
        canvas: "var(--canvas)",
        sidebar: "var(--sidebar)",
        panel: "var(--panel)",
        elevated: "var(--elevated)",
        hover: "var(--hover)",
        edge: "var(--edge)",
        "edge-strong": "var(--edge-strong)",
        // Semantic status colors. Components must use THESE, never a raw
        // `red-950`/`amber-200` step: a palette step bakes in one theme's
        // ground and breaks on the other. Guarded by a unit test.
        danger: {
          DEFAULT: "var(--danger)",
          bg: "var(--danger-bg)",
          strong: "var(--danger-bg-strong)",
          border: "var(--danger-border)",
        },
        warn: {
          DEFAULT: "var(--warn)",
          fg: "var(--warn-fg)",
          bg: "var(--warn-bg)",
          border: "var(--warn-border)",
        },
        success: {
          DEFAULT: "var(--success)",
          bg: "var(--success-bg)",
          border: "var(--success-border)",
        },
        code: "var(--code-bg)",
        scrim: "var(--scrim)",
        // Syntax-highlight slots (src/lib/highlight.ts). Themed like everything
        // else so a code block is legible on a white page too.
        syn: {
          str: "var(--syn-str)",
          num: "var(--syn-num)",
          kw: "var(--syn-kw)",
          com: "var(--syn-com)",
          name: "var(--syn-name)",
          tag: "var(--syn-tag)",
          punct: "var(--syn-punct)",
        },
        // v3.0 — the one hue: primary fill, selection tint, link text, focus.
        accent: {
          DEFAULT: "var(--accent)",
          soft: "var(--accent-soft)",
          dim: "var(--accent-dim)",
          fg: "var(--accent-fg)",
          text: "var(--accent-text)",
        },
        // Remap the neutral ramp to theme vars so text-gray-100..700 inverts
        // correctly between dark and light (100 = strongest, 700 = faintest).
        gray: {
          100: "var(--gray-100)",
          200: "var(--gray-200)",
          300: "var(--gray-300)",
          400: "var(--gray-400)",
          500: "var(--gray-500)",
          600: "var(--gray-600)",
          700: "var(--gray-700)",
        },
      },
      // The product type scale (v0.56.0).
      //
      // Before this there was no scale. A count across the components found 157
      // uses of arbitrary pixel sizes spanning FOURTEEN distinct values — 9.5,
      // 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16 and 23px —
      // alongside 70 uses of Tailwind's own steps. Half-pixel neighbours like
      // 10.5 against 11 are invisible to a reader and guarantee that two panels
      // built a week apart never line up.
      //
      // Eight steps, each with a line-height chosen for its job rather than
      // inherited: the dense ones (3xs/2xs) are trace rows and metadata where
      // vertical rhythm matters more than air; `sm` is the reading size for
      // conversation text. Every arbitrary value was migrated to its nearest
      // step, so the scale is what the UI actually uses, not an aspiration.
      // Optical tracking is part of the size, so it lives in the scale.
      //
      // Inter is drawn on a single optical size and needs the tracking a
      // typeface with real optical sizes would give you for free: opened up at
      // caption sizes so 11px chrome does not clot, tightened at display sizes
      // so a heading does not read as a row of separate letters. rsms publishes
      // a curve for this; these are its values at our steps. Shipping a webfont
      // without them is most of the way to still looking unset.
      fontSize: {
        // v3.0 — five sizes, each with one job: 11 label · 13 interface ·
        // 15 reading · 20 conclusion · 28 page title. `xs`, `sm` and `base`
        // are one size (13, the interface) and `lg` is the reading size set
        // as a title (weight does the rest): hierarchy comes from the text
        // ladder and weight, never from 1px steps nobody can see.
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.01em" }],     // 11px — labels, meta, badges, keycaps
        xs: ["0.8125rem", { lineHeight: "1.25rem", letterSpacing: "-0.003em" }],   // 13px — interface
        sm: ["0.8125rem", { lineHeight: "1.25rem", letterSpacing: "-0.003em" }],   // 13px — interface
        base: ["0.8125rem", { lineHeight: "1.25rem", letterSpacing: "-0.003em" }], // 13px — interface
        prose: ["0.9375rem", { lineHeight: "1.7", letterSpacing: "-0.006em" }],    // 15px — reading
        lg: ["0.9375rem", { lineHeight: "1.5rem", letterSpacing: "-0.008em" }],    // 15px — titles in the reading size
        xl: ["1.25rem", { lineHeight: "1.75rem", letterSpacing: "-0.014em" }],     // 20px — the conclusion
        "2xl": ["1.75rem", { lineHeight: "2.125rem", letterSpacing: "-0.022em" }], // 28px — page titles, the greeting
      },
      // v1.19 — the platform's UI face first (native), vendored Inter as the
      // fallback, then CJK faces. See the body rule in index.css.
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI Variable Text",
          "Segoe UI",
          "Inter Variable",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei UI",
          "Microsoft YaHei",
          "Noto Sans CJK SC",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono Variable",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "monospace",
        ],
      },
      // The product radius scale (v0.58.0).
      //
      // Same drift the type scale had before v0.56.0, one layer down: a count
      // found TEN distinct corner radii in use — seven named steps plus
      // `[3px]`, `[5px]` and `[22px]` written inline. Corners are the most
      // repeated shape in the UI, so a stray radius reads as two components
      // built by two people.
      //
      // The existing steps keep their existing values on purpose: renumbering
      // them would silently restyle 100+ elements with no way to verify the
      // result short of looking at every screen. What changes is that the scale
      // is now DECLARED (so it can be enumerated and guarded) and the three
      // inline values were migrated onto it — `sm` and `3xl` exist because the
      // UI genuinely needed a 3px mark and a 22px composer pill, not to make
      // the table look complete.
      borderRadius: {
        // v3.0 — three radii: 6 controls · 10 cards and menus · 14 panels and
        // dialogs. The older names alias onto them.
        sm: "0.375rem",      // 6px
        DEFAULT: "0.375rem", // 6px
        md: "0.375rem",      // 6px  — controls: buttons, inputs, keycaps, rows
        lg: "0.625rem",      // 10px — cards, menus
        xl: "0.625rem",      // 10px
        "2xl": "0.875rem",   // 14px — panels, dialogs, the composer
        "3xl": "0.875rem",   // 14px
        full: "9999px",      // pills and dots
      },
      // Named stacking layers (v0.58.0).
      //
      // Eight z-index values were in use and four of them were arbitrary —
      // `z-[60]`, `z-[70]`, `z-[75]`, `z-[80]` — with the intended order living
      // nowhere but in the numbers themselves. Whoever added the ninth overlay
      // had to grep for the highest number and add one.
      //
      // The NUMBERS are unchanged; only the names are new. Renumbering would
      // have risked a stacking regression for no benefit, and the point here is
      // that a layer now has a name to reason about.
      zIndex: {
        sticky: "30",    // in-flow chrome that pins: find bar, rail headers
        floating: "40",  // in-page affordances: jump-to-latest, rail scrim
        drawer: "50",    // settings, inspector, import dialog
        sheet: "60",     // review overlay sheet — above the task, below the palette
        palette: "70",   // ⌘K — reachable from anywhere, so above every sheet
        shortcuts: "75", // the help sheet, openable from the palette
        toast: "80",     // always visible; nothing may cover a failure notice
      },
      boxShadow: {
        elev: "var(--shadow-elev)",
        pop: "var(--shadow-pop)",
        glow: "var(--shadow-glow)",
      },
      transitionDuration: {
        instant: "var(--duration-instant)",
        fast: "var(--duration-fast)",
        DEFAULT: "var(--duration-base)",
        slow: "var(--duration-slow)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        emphasized: "var(--ease-emphasized)",
        "in-out": "var(--ease-in-out)",
      },
      keyframes: {
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        // Transform only. An opaque panel that animates its own opacity is
        // TRANSLUCENT for the length of the animation: the settings drawer
        // spent 260ms with the thread's heading legible straight through it, on
        // every single open. The scrim behind it carries the fade; the panel
        // slides. (The same rule is why `scale-in` keeps its opacity — a
        // menu popping from 97% wants the fade, and it is not covering
        // anything the eye is reading.)
        "slide-in-right": {
          "0%": { transform: "translateX(24px)" },
          "100%": { transform: "translateX(0)" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.97)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        // Transform only, for opaque dialogs (see slide-in-right).
        "rise-in": {
          "0%": { transform: "translateY(8px)" },
          "100%": { transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in-up": "fade-in-up var(--duration-slow) var(--ease-out)",
        "fade-in": "fade-in var(--duration-base) var(--ease-out)",
        "slide-in-right": "slide-in-right var(--duration-base) var(--ease-out)",
        "scale-in": "scale-in var(--duration-base) var(--ease-out)",
        "rise-in": "rise-in var(--duration-base) var(--ease-out)",
        shimmer: "token-shimmer 1.35s var(--ease-in-out) infinite",
      },
    },
  },
  plugins: [],
};
