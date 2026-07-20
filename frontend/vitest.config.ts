import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest config kept SEPARATE from vite.config.ts so the production build never
// pulls in the jsdom/test-only toolchain. jsdom gives the store/hook tests a DOM;
// setup.ts wires @testing-library/jest-dom matchers.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
