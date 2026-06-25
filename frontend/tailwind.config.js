/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#16181d",
        sidebar: "#0f1115",
        canvas: "#1b1e24",
        edge: "#2a2e37",
      },
    },
  },
  plugins: [],
};
