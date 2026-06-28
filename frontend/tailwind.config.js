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
