/**
 * v0.57.0 — the design tokens are enforced, not merely applied.
 *
 * v0.56.0 introduced a type scale and migrated 157 arbitrary pixel sizes onto
 * it. Nothing stopped the 158th: a new `text-[13.5px]` would have passed CI
 * silently and the drift would have started over. This is the guard.
 *
 * It also catches a subtler class of mistake made while writing v0.57.0 itself:
 * `w-6.5` and `w-13` are NOT Tailwind spacing steps, so those classes compiled
 * to nothing at all — a silent visual regression that typechecks, builds, and
 * renders wrong.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const SOURCES = walk(join(__dirname));
const ALL = SOURCES.map((f) => ({ file: f, text: readFileSync(f, "utf8") }));

/** Tailwind's default spacing steps (v3), which are the only bare numeric
 * spacing classes that compile. Anything else must be an explicit arbitrary
 * value — visible as such — rather than a class that silently does nothing. */
const SPACING = new Set([
  "0", "px", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "5", "6", "7", "8",
  "9", "10", "11", "12", "14", "16", "20", "24", "28", "32", "36", "40", "44",
  "48", "52", "56", "60", "64", "72", "80", "96",
]);

describe("the type scale", () => {
  it("has no arbitrary font sizes left anywhere", () => {
    const offenders: string[] = [];
    for (const { file, text } of ALL) {
      for (const m of text.matchAll(/text-\[[0-9.]+(?:px|rem|em)\]/g)) {
        offenders.push(`${file}: ${m[0]}`);
      }
    }
    // 157 of these were migrated in v0.56.0. The scale only stays a scale if the
    // next one fails here instead of shipping.
    expect(offenders).toEqual([]);
  });

  it("uses only steps the config actually defines", () => {
    const config = readFileSync(join(__dirname, "..", "tailwind.config.js"), "utf8");
    const defined = new Set(
      [...config.matchAll(/^\s*"?([a-z0-9]+)"?:\s*\["?[0-9.]+rem/gm)].map((m) => m[1]),
    );
    expect(defined.size).toBeGreaterThan(4);
    const used = new Set<string>();
    for (const { text } of ALL) {
      for (const m of text.matchAll(/\btext-([a-z0-9]+)\b/g)) used.add(m[1]);
    }
    // Colour utilities share the `text-` prefix; only size-shaped names apply.
    const sizeish = [...used].filter((u) => /^(?:[0-9]?x?s|sm|base|lg|xl|[0-9]xl)$/.test(u));
    const unknown = sizeish.filter((u) => !defined.has(u));
    expect(unknown).toEqual([]);
  });
});

describe("the radius scale", () => {
  it("has no arbitrary corner radii left", () => {
    // v0.58.0 migrated `rounded-[3px]`, `rounded-[5px]` and `rounded-[22px]`
    // onto real steps. Corners are the most repeated shape in the UI, so a
    // stray radius reads as two components built by two different people.
    const offenders: string[] = [];
    for (const { file, text } of ALL) {
      for (const m of text.matchAll(/rounded[a-z-]*-\[[^\]]+\]/g)) {
        offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses only steps the config actually defines", () => {
    const config = readFileSync(join(__dirname, "..", "tailwind.config.js"), "utf8");
    const block = config.slice(config.indexOf("borderRadius:"));
    const defined = new Set(
      [...block.slice(0, block.indexOf("},")).matchAll(/^\s*"?([A-Za-z0-9]+)"?:\s*"/gm)]
        .map((m) => (m[1] === "DEFAULT" ? "" : m[1])),
    );
    expect(defined.size).toBeGreaterThan(4);
    const sides = "(?:[tbrl]|tl|tr|bl|br)";
    const used = new Set<string>();
    for (const { text } of ALL) {
      for (const m of text.matchAll(new RegExp(`\\brounded(?:-${sides})?(?:-([a-z0-9]+))?\\b`, "g"))) {
        used.add(m[1] ?? "");
      }
    }
    // A side-only class (`rounded-t`) resolves to the DEFAULT radius, which the
    // empty-string entry above represents.
    const unknown = [...used].filter((u) => !defined.has(u));
    expect(unknown).toEqual([]);
  });
});

describe("stacking layers", () => {
  it("are named, never raw numbers", () => {
    // Eight z-index values were in use and four were arbitrary, with the
    // intended order recorded nowhere but in the numbers. Adding the ninth
    // overlay meant grepping for the highest and adding one.
    const offenders: string[] = [];
    for (const { file, text } of ALL) {
      for (const m of text.matchAll(/\bz-(?:\[[^\]]+\]|\d+)/g)) {
        offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only uses layers the config defines", () => {
    const config = readFileSync(join(__dirname, "..", "tailwind.config.js"), "utf8");
    const block = config.slice(config.indexOf("zIndex:"));
    const defined = new Set(
      [...block.slice(0, block.indexOf("},")).matchAll(/^\s*([a-z]+):\s*"/gm)].map((m) => m[1]),
    );
    expect(defined.size).toBeGreaterThan(3);
    const used = new Set<string>();
    for (const { text } of ALL) {
      for (const m of text.matchAll(/\bz-([a-z]+)\b/g)) used.add(m[1]);
    }
    // `z-auto` is Tailwind's own and carries no layer meaning.
    const unknown = [...used].filter((u) => u !== "auto" && !defined.has(u));
    expect(unknown).toEqual([]);
  });
});

describe("motion", () => {
  it("never animates every property at once", () => {
    const offenders: string[] = [];
    for (const { file, text } of ALL) {
      for (const m of text.matchAll(/\btransition-all\b/g)) offenders.push(`${file}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("defines motion, type, radius and shadow tokens", () => {
    const css = readFileSync(join(__dirname, "index.css"), "utf8");
    for (const token of [
      "--duration-instant", "--duration-fast", "--duration-base", "--duration-slow",
      "--ease-out", "--ease-emphasized", "--ease-in-out",
      "--text-2xs", "--text-prose", "--text-2xl",
      "--radius-sm", "--radius-3xl",
      "--control-h", "--header-h",
      "--shadow-elev", "--shadow-pop", "--shadow-glow",
      "--viz-1", "--viz-6",
    ]) {
      expect(css, token).toContain(`${token}:`);
    }
  });
});

describe("spacing classes", () => {
  it("never uses a bare step Tailwind does not define", () => {
    // `w-6.5` and `w-13` look plausible and compile to NOTHING. This is the only
    // check that catches them: typecheck passes, the build passes, and the
    // element silently loses its size.
    const offenders: string[] = [];
    const pat = /\b(?:p|m|w|h|gap|space|inset|top|left|right|bottom|min-w|min-h|max-w|max-h)(?:[xytrbl])?-([0-9]+(?:\.[0-9]+)?)\b/g;
    for (const { file, text } of ALL) {
      for (const m of text.matchAll(pat)) {
        if (!SPACING.has(m[1])) offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
