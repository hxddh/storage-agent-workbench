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
        // Single restrained accent (Cursor/Codex-style indigo-blue).
        accent: {
          DEFAULT: "var(--accent)",
          soft: "var(--accent-soft)",
          dim: "var(--accent-dim)",
          fg: "var(--accent-fg)",
        },
        // Remap the neutral ramp to theme vars so text-gray-100..700 inverts
        // correctly between dark and light (100 = strongest, 700 = faintest).
        gray: {
          100: "var(--gray-100)",
          200: "var(--gray-200)",
          300: "var(--gray-300)",
          400: "var(--gray-400)",
          500: "var(--gray-500)",
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
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.006em" }],   // 11px — badges, keycaps, indices
        xs: ["0.75rem", { lineHeight: "1.125rem", letterSpacing: "0.003em" }],    // 12px — secondary UI, metadata
        sm: ["0.8125rem", { lineHeight: "1.375rem", letterSpacing: "0.001em" }],  // 13px — dense UI chrome
        // The surface people READ. 13px is what a dense admin panel uses, and
        // the reference set for this product sets an agent's prose at 15-16px.
        // Separate from `sm` on purpose: raising `sm` would inflate every button
        // and label in the app along with the prose.
        prose: ["0.9375rem", { lineHeight: "1.75", letterSpacing: "-0.003em" }],  // 15px — answers
        base: ["0.875rem", { lineHeight: "1.5rem", letterSpacing: "0em" }],       // 14px — emphasis
        lg: ["1rem", { lineHeight: "1.5rem", letterSpacing: "-0.008em" }],        // 16px — section titles
        xl: ["1.1875rem", { lineHeight: "1.625rem", letterSpacing: "-0.014em" }], // 19px
        "2xl": ["1.4375rem", { lineHeight: "1.875rem", letterSpacing: "-0.019em" }], // 23px — display
      },
      // Vendored faces first, then the platform's own — including its CJK face,
      // which Inter cannot supply. See the @font-face block in index.css.
      fontFamily: {
        sans: [
          "Inter Variable",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "Noto Sans CJK SC",
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
        sm: "0.1875rem",    // 3px  — inline marks, checkbox glyphs
        DEFAULT: "0.25rem", // 4px  — dense chips
        md: "0.375rem",     // 6px  — controls: buttons, inputs, keycaps
        lg: "0.5rem",       // 8px  — cards and rows
        xl: "0.75rem",      // 12px — panels
        "2xl": "1rem",      // 16px — overlays
        "3xl": "1.375rem",  // 22px — the composer pill
        full: "9999px",     // pills and dots
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
        wizard: "60",    // first-run — above the drawers it explains
        palette: "70",   // ⌘K — reachable from anywhere, so above the wizard
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
        "pulse-ring": {
          "0%": { boxShadow: "0 0 0 0 rgba(84,176,138,0.5)" },
          "70%": { boxShadow: "0 0 0 5px rgba(84,176,138,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(84,176,138,0)" },
        },
      },
      animation: {
        "fade-in-up": "fade-in-up var(--duration-slow) var(--ease-out)",
        "fade-in": "fade-in var(--duration-base) var(--ease-out)",
        "slide-in-right": "slide-in-right var(--duration-base) var(--ease-out)",
        "scale-in": "scale-in var(--duration-base) var(--ease-out)",
        "pulse-ring": "pulse-ring 2s var(--ease-out) infinite",
        shimmer: "token-shimmer 1.35s var(--ease-in-out) infinite",
      },
    },
  },
  plugins: [],
};
