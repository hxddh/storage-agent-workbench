import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every production module under src/ is imported by something. A component
 * nothing renders is a second, unreviewed product surface waiting to be wired
 * back in (v1.09 shipped one: EvidenceActivity.tsx). Tests, the entry point,
 * and type-only barrels are the only files allowed to stand alone.
 */
const srcRoot = join(process.cwd(), "src");
const entryPoints = new Set(["main.tsx", "vite-env.d.ts"]);
const isTest = (path: string) => /\.test\.tsx?$/.test(path) || /\/test\//.test(path);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(?:ts|tsx)$/.test(path)) out.push(path);
  }
  return out;
}

describe("production modules", () => {
  it("are all imported by something (no orphan components or hooks)", () => {
    const files = walk(srcRoot);
    const sources = files.map((path) => readFileSync(path, "utf8")).join("\n");
    const orphans = files
      .filter((path) => !isTest(path) && !entryPoints.has(basename(path)))
      .filter((path) => {
        const stem = basename(path).replace(/\.tsx?$/, "");
        const pattern = new RegExp(`from\\s+["'][^"']*/${stem}(?:\\.js)?["']|import\\(["'][^"']*/${stem}["']\\)|vi\\.mock\\(["'][^"']*/${stem}["']`);
        return !pattern.test(sources);
      })
      .map((path) => relative(srcRoot, path));
    expect(orphans).toEqual([]);
  });
});
