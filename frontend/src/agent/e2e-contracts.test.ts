import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const e2eRoot = join(process.cwd(), "e2e");
const specs = readdirSync(e2eRoot)
  .filter((name) => name.endsWith(".spec.ts"))
  .map((name) => ({ name, source: readFileSync(join(e2eRoot, name), "utf8") }));

const forbidden: Array<[string, RegExp]> = [
  ["old long-thread spec", /longthread\.spec\.ts/i],
  ["chat composer placeholder", /Ask Storage Agent/i],
  ["old Chinese chat composer placeholder", /向云存储 Agent 提问/],
  ["chat creation language", /\bNew chat\b/i],
  ["investigation creation selector", /new investigation/i],
  ["investigation find selector", /Find in this investigation/i],
  ["legacy command palette copy", /Search chats or run a command/i],
  ["conversation landmark contract", /getByRole\(["']main["'][\s\S]{0,80}conversation/i],
  ["thread item selector", /(?:\.thread-item|thread-item)/i],
  ["thread scroll selector", /thread-scroll/i],
  ["thread prose/bleed selector", /(?:\.thread-prose|\.thread-bleed)/i],
  ["session rail selector", /session-rail/i],
  ["rail test-id selector", /getByTestId\(["']rail-/i],
  ["old rail palette selector", /rail-open-palette/i],
  ["Workbench shell selector", /workbench-shell/i],
  ["Workbench commandbar selector", /workbench-commandbar/i],
  ["Inspector selector", /session-inspector/i],
  ["v0.92 surface selector", /surface-tabs/i],
  ["old surface navigation language", /(?:Timeline\s*\/\s*Evidence\s*\/\s*Runs\s*\/\s*Report|openWorkbenchSurface|openWorkbenchRun)/],
  ["live execution strip selector", /agent-live-status/],
  ["command-center queue selector", /task-queue-(needs-you|running)/],
  ["Focus mode selector", /agent-focus-toggle|data-focus=/],
  ["execution summary toggle", /execution-summary-toggle/],
  ["Direction rerun selector", /rerun-direction/],
  ["painted palette button in navigation", /task-navigation-palette/],
];

describe("real-browser tests target the Agent-native UI only", () => {
  it("physically removes the long-thread test file", () => {
    expect(readdirSync(e2eRoot)).not.toContain("longthread.spec.ts");
    expect(readdirSync(e2eRoot)).toContain("long-task.spec.ts");
  });

  for (const [label, pattern] of forbidden) {
    it(`contains no ${label}`, () => {
      const offenders = specs.filter(({ source }) => pattern.test(source)).map(({ name }) => name);
      expect(offenders, `${label}: ${offenders.join(", ")}`).toEqual([]);
    });
  }
});
