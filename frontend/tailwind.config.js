/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Layered dark surfaces (deepest → most elevated).
        canvas: "#0c0d10",
        sidebar: "#101218",
        panel: "#15171d",
        elevated: "#1c1f27",
        hover: "#21242d",
        edge: "#262a33",
        "edge-strong": "#343945",
        accent: {
          DEFAULT: "#10b981",
          soft: "#34d399",
          dim: "#0b3a2e",
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
        elev: "0 1px 2px rgba(0,0,0,0.4), 0 12px 32px -16px rgba(0,0,0,0.7)",
        pop: "0 8px 40px -8px rgba(0,0,0,0.65)",
        glow: "0 0 0 1px rgba(16,185,129,0.25), 0 4px 16px -4px rgba(16,185,129,0.25)",
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
          "0%": { boxShadow: "0 0 0 0 rgba(16,185,129,0.5)" },
          "70%": { boxShadow: "0 0 0 5px rgba(16,185,129,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(16,185,129,0)" },
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
