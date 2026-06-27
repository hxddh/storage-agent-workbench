/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Layered near-monochrome dark surfaces (deepest → most elevated).
        canvas: "#0b0b0d",
        sidebar: "#0e0f12",
        panel: "#141519",
        elevated: "#1a1c21",
        hover: "#202329",
        edge: "#1d1f25",
        "edge-strong": "#2a2d35",
        // Single restrained accent (Cursor/Codex-style indigo-blue).
        accent: {
          DEFAULT: "#6d8bff",
          soft: "#84acff",
          dim: "#161a2b",
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
