import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = fileURLToPath(new URL("../", import.meta.url));
const roots = [join(srcRoot, "components"), join(srcRoot, "workbench")];
const standalone = [join(srcRoot, "App.tsx"), join(srcRoot, "shortcuts.ts")];
const extensions = /\.(?:ts|tsx|css)$/;
const skip = /(?:\.test\.|architecture\.test\.ts$|legacy-ui-contracts\.test\.ts$)/;

function productionFiles(): string[] {
  const files = [...standalone];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (extensions.test(path) && !skip.test(path)) files.push(path);
    }
  };
  roots.forEach(walk);
  return files;
}

const forbidden: Array<[string, RegExp]> = [
  ["chat product language", /\bchat(?:s)?\b/i],
  ["conversation product language", /\bconversation\b/i],
  ["investigation product language", /\binvestigation\b/i],
  ["Thread component contract", /\bThread(?:Implementation)?\b/],
  ["thread DOM/copy contract", /(?:thread[-.]|thread_)/i],
  ["SessionRail contract", /\bSessionRail\b/],
  ["rail DOM/copy contract", /(?:rail[-.]|rail_)/i],
  ["SessionInspector contract", /\bSessionInspector\b/],
  ["inspector DOM/copy contract", /(?:inspector[-.]|inspector_)/i],
  ["v0.92 surface contract", /\b(?:SurfaceTabs|WorkSurface|SteeringSurface)\b/],
];

describe("Agent-native production UI has no v0.92 Chat-era contracts", () => {
  for (const [label, pattern] of forbidden) {
    it(`contains no ${label}`, () => {
      const offenders = productionFiles()
        .filter((path) => pattern.test(readFileSync(path, "utf8")))
        .map((path) => relative(srcRoot, path));
      expect(offenders, `${label}: ${offenders.join(", ")}`).toEqual([]);
    });
  }
});
