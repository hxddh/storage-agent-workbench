import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri v2 expects the dev server on a fixed port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "es2021",
  },
});
