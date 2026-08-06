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
      fontSize: {
        "3xs": ["0.625rem", { lineHeight: "0.875rem" }],   // 10px — dense metadata
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],      // 11px — trace rows
        xs: ["0.75rem", { lineHeight: "1.125rem" }],       // 12px — secondary UI
        sm: ["0.8125rem", { lineHeight: "1.375rem" }],     // 13px — body / answers
        base: ["0.875rem", { lineHeight: "1.5rem" }],      // 14px — emphasis
        lg: ["1rem", { lineHeight: "1.5rem" }],            // 16px — section titles
        xl: ["1.1875rem", { lineHeight: "1.625rem" }],     // 19px
        "2xl": ["1.4375rem", { lineHeight: "1.875rem" }],  // 23px — display
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "ui-sans-serif",
          "system-ui",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "monospace"],
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem",
      },
      boxShadow: {
        elev: "0 1px 2px rgba(0,0,0,0.35), 0 8px 28px -18px rgba(0,0,0,0.7)",
        pop: "0 10px 44px -10px rgba(0,0,0,0.7)",
        glow: "0 0 0 1px rgba(109,139,255,0.3)",
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
        "slide-in-right": {
          "0%": { opacity: "0", transform: "translateX(24px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
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
        "fade-in-up": "fade-in-up 0.28s cubic-bezier(0.21,0.6,0.35,1)",
        "fade-in": "fade-in 0.2s ease-out",
        "slide-in-right": "slide-in-right 0.26s cubic-bezier(0.21,0.6,0.35,1)",
        "scale-in": "scale-in 0.2s cubic-bezier(0.21,0.6,0.35,1)",
        "pulse-ring": "pulse-ring 2s ease-out infinite",
      },
    },
  },
  plugins: [],
};
