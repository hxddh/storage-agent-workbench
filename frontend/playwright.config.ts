import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke config.
 *
 * These tests drive the REAL stack: a live Python sidecar (started by
 * `e2e/global-setup.ts` on its own port, against a throwaway data dir) plus the
 * production frontend bundle served by `vite preview`. Everything below the
 * composer — HTTP wiring, SSE, SQLite, the deterministic triage engine — runs
 * for real. Only the model provider is absent, which is deliberate: the offline
 * paths (error triage, session CRUD, settings) are exactly the ones that must
 * work on a fresh install with no credentials, and they need no LLM.
 *
 * The bundle is built with VITE_SIDECAR_URL pointing at the test sidecar,
 * because `config.ts` bakes that value at build time. Port 5173 is not
 * arbitrary either — it is one of the origins the sidecar's CORS allowlist
 * accepts (`sidecar/app/main.py`), so a different port would fail preflight.
 */
const SIDECAR_PORT = Number(process.env.E2E_SIDECAR_PORT || 8799);
const WEB_PORT = 5173;

export default defineConfig({
  testDir: "./e2e",
  // `e2e/shots/` is a development contact sheet, not a gate: it writes PNGs for
  // a human to look at and asserts nothing about them. It is reached only via
  // `npm run shots`, which sets SHOTS=1. See e2e/shots/gallery.spec.ts for why
  // pixel-diff baselines are not viable here.
  testIgnore: process.env.SHOTS ? [] : ["shots/**"],
  // The suite is a smoke gate, not a matrix: keep it serial and fast so it can
  // sit in the CI critical path without becoming the slowest job.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0, // v0.99: never mask interaction regressions; fake-model replays by signature
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The override has to live on the PROJECT, not on the top-level `use`:
  // `devices["Desktop Chrome"]` is spread into the project and replaces the
  // inherited `launchOptions` wholesale, so a top-level one silently vanishes.
  // Local sandboxes ship a preinstalled browser at a pinned revision that may
  // not match this Playwright build; CI installs the matching one in the
  // default location and leaves PW_CHROMIUM_PATH unset.
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.PW_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${WEB_PORT} --strictPort`,
    url: `http://127.0.0.1:${WEB_PORT}`,
    // A shots run NEVER reuses a server.
    //
    // The web server here is `vite build && vite preview`, not a dev server, so
    // a reused one keeps serving whatever bundle it was started with — no HMR,
    // no rebuild. That is fine for a test run (Playwright starts and stops its
    // own), and it is a trap for the contact sheet: a gallery regenerated
    // against a leftover preview photographs the PREVIOUS build, which is
    // exactly how a rail change that was already committed came back showing
    // the old rail. The whole point of the sheet is to show what the code does
    // now, so it pays for a rebuild every time.
    reuseExistingServer: !process.env.CI && !process.env.SHOTS,
    timeout: 120_000,
    env: { VITE_SIDECAR_URL: `http://127.0.0.1:${SIDECAR_PORT}` },
  },
});
