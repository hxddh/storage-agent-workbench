import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Start a real sidecar for the E2E run.
 *
 * Isolation matters more than speed here: the sidecar gets a throwaway
 * `STORAGE_AGENT_DATA_DIR` (fresh SQLite, fresh vault, no providers), so a
 * developer's real workbench data is never touched and every run starts from
 * the same first-install state the tests assert against. No auth token is set,
 * which puts the sidecar in its documented dev/test mode (see the
 * `_require_sidecar_token` middleware) — the token path belongs to the packaged
 * Tauri shell, not to this harness.
 *
 * The pid + data dir are handed to teardown through a temp file rather than a
 * module global: Playwright may load setup and teardown in different module
 * registries, and a leaked sidecar would hold the port for the next run.
 */
const SIDECAR_PORT = Number(process.env.E2E_SIDECAR_PORT || 8799);
export const STATE_FILE = path.join(os.tmpdir(), "saw-e2e-sidecar.json");

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never contacted";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = String(e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`sidecar did not become healthy at ${url}: ${lastErr}`);
}

export default async function globalSetup(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "saw-e2e-"));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sidecarDir = path.resolve(here, "../../sidecar");

  const child = spawn(
    process.env.E2E_PYTHON || "python3",
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(SIDECAR_PORT)],
    {
      cwd: sidecarDir,
      env: { ...process.env, STORAGE_AGENT_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  // Keep the last lines of sidecar output so a startup failure reports WHY
  // instead of a bare timeout.
  let log = "";
  const keep = (buf: Buffer) => {
    log = (log + buf.toString()).slice(-4000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) log += `\n[sidecar exited with code ${code}]`;
  });

  // Did OUR sidecar answer, or someone else's? A leaked sidecar from an
  // interrupted run still holds the port, uvicorn then exits with "address
  // already in use", and the health probe passes against the stranger — so the
  // suite talks to one process while seeding the data dir of another, and fails
  // as `no such table: sessions` several layers away from the cause. Cost an
  // afternoon once; the check is two lines.
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  try {
    await waitForHealth(`http://127.0.0.1:${SIDECAR_PORT}/health`, 60_000);
    if (exited) {
      throw new Error(
        `port ${SIDECAR_PORT} is already serving a DIFFERENT sidecar — the one ` +
          `started here exited immediately. Stop the stray process (it is usually ` +
          `a leaked sidecar from an interrupted run) or set E2E_SIDECAR_PORT.`,
      );
    }
  } catch (err) {
    child.kill("SIGKILL");
    throw new Error(`${(err as Error).message}\n--- sidecar output ---\n${log}`);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: child.pid, dataDir }));
  // Detach the reference so this process can exit even if teardown is skipped;
  // teardown kills by pid.
  child.unref();
}
