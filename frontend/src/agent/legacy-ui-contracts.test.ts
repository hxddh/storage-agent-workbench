import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = join(process.cwd(), "src");
const extensions = /\.(?:ts|tsx|css)$/;
const skip = /(?:\.test\.|architecture\.test\.ts$|legacy-ui-contracts\.test\.ts$|e2e-contracts\.test\.ts$|documentation-contract\.test\.ts$)/;

function productionFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (extensions.test(path) && !skip.test(path)) files.push(path);
    }
  };
  walk(srcRoot);
  return files;
}

const forbidden: Array<[string, RegExp]> = [
  ["chat product language", /\bchat(?:s)?\b/i],
  ["conversation product language", /\bconversation\b/i],
  ["investigation product language", /\binvestigation\b/i],
  ["Chinese chat-era product language", /(?:新对话|对话|会话检查器|会话发现|本次调查|调查|线程)/],
  ["Thread component contract", /\bThread(?:Implementation)?\b/],
  ["thread DOM/copy contract", /(?:thread[-.]|thread_)/i],
  ["SessionRail contract", /\bSessionRail\b/],
  ["rail DOM/copy contract", /(?:rail[-.]|rail_)/i],
  ["SessionInspector contract", /\bSessionInspector\b/],
  ["inspector DOM/copy contract", /(?:inspector[-.]|inspector_)/i],
  ["timeline-era execution component", /\b(?:ToolTimeline|TimelineItem)\b/],
  ["timeline DOM/copy contract", /(?:timeline[-.]|timeline_)/i],
  ["v0.92 surface contract", /\b(?:SurfaceTabs|WorkSurface|SteeringSurface)\b/],
  ["legacy shortcut contract", /keys\.(?:inspector|prevTurn|nextTurn|toggleRail)/],
  ["legacy continuation action", /continueInvestigation/],
  ["legacy run timeline key", /run\.timeline/],
  ["legacy user-facing phrases", /(?:Session inspector|Session findings|User prompt|finished answer|Start investigating|Storage Agent Workbench)/i],
  ["chatbot answer phrasing", /(?:Why this answer|Ask again|Edit and send again|Drafting a response|answer questions|before the agent can answer|重新提问|编辑后重新发送|正在组织回答|才能作答)/i],
  ["answer/turn UI key contract", /(?:a11y\.answerReady|answer\.outline|turn\.(?:checks|failed|trace))/],
  ["workbench budget phrasing", /(?:workbench's own per-execution ceiling|本产品自己的每轮上限)/i],
  ["Workbench shell identifier", /\bWorkbenchShell\b/],
  ["Workbench projection identifier", /\buseWorkbenchProjection\b/],
  ["Workbench copy identifier", /\buseWorkbenchCopy\b/],
  ["Workbench module import", /(?:\.\.\/|\.\/)workbench\//],
  ["Workbench DOM/CSS contract", /(?:workbench[-_]|workbench\.css)/i],
];

describe("Agent-native production UI has no v0.92 Chat-era contracts", () => {
  it("has no Workbench module directory", () => {
    expect(existsSync(join(srcRoot, "workbench"))).toBe(false);
    expect(existsSync(join(srcRoot, "agent"))).toBe(true);
  });

  for (const [label, pattern] of forbidden) {
    it(`contains no ${label}`, () => {
      const offenders = productionFiles()
        .filter((path) => pattern.test(readFileSync(path, "utf8")))
        .map((path) => relative(srcRoot, path));
      expect(offenders, `${label}: ${offenders.join(", ")}`).toEqual([]);
    });
  }
});
