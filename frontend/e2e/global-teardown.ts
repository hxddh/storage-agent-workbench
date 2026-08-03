import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_FILE = path.join(os.tmpdir(), "saw-e2e-sidecar.json");

/** Stop the E2E sidecar and remove its throwaway data dir. Never throws — a
 * teardown failure must not turn a green run red. */
export default async function globalTeardown(): Promise<void> {
  let state: { pid?: number; dataDir?: string } = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return; // setup never got far enough to write it
  }
  if (state.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
      // Give uvicorn a moment for a graceful stop, then insist.
      await new Promise((r) => setTimeout(r, 1000));
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {
        /* already gone — the graceful stop worked */
      }
    } catch {
      /* already gone */
    }
  }
  if (state.dataDir && state.dataDir.includes("saw-e2e-")) {
    fs.rmSync(state.dataDir, { recursive: true, force: true });
  }
  fs.rmSync(STATE_FILE, { force: true });
}
