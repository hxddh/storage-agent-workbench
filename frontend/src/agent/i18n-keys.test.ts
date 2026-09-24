import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every dictionary key is copy for a surface that exists. Retired surfaces
 * (the import dialog, the account profile table, proposal-era actions, the
 * metrics footer, table pagination, the painted Find/palette buttons) took
 * ~115 keys of dead copy with them only in v1.18; this keeps it that way.
 * Keys built at runtime must use one of the named dynamic prefixes.
 */
const srcRoot = join(process.cwd(), "src");
const DYNAMIC_PREFIXES = ["confidence.", "severity.", "settings.policy."];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(?:ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.endsWith("i18n.tsx")) out.push(path);
  }
  return out;
}

function dictKeys(i18n: string, name: "en" | "zh"): string[] {
  const start = i18n.indexOf(`const ${name}: Dict = {`);
  const end = i18n.indexOf("\n};", start);
  return [...i18n.slice(start, end).matchAll(/^\s+"([^"]+)":/gm)].map((m) => m[1]);
}

describe("i18n dictionaries", () => {
  const i18n = readFileSync(join(srcRoot, "i18n.tsx"), "utf8");
  const en = dictKeys(i18n, "en");
  const zh = dictKeys(i18n, "zh");

  it("keep English/Chinese parity", () => {
    expect([...zh].sort()).toEqual([...en].sort());
  });

  it("carry no key that no production module references", () => {
    const sources = walk(srcRoot).map((path) => readFileSync(path, "utf8")).join("\n");
    const dead = en.filter((key) =>
      !sources.includes(`"${key}"`) &&
      !sources.includes(`'${key}'`) &&
      !DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix)));
    expect(dead).toEqual([]);
  });
});
