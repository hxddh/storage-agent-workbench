/**
 * The light theme is only as good as the weakest component in it.
 *
 * Every surface colour goes through a CSS variable so the app can invert
 * cleanly between themes — but a single hardcoded `bg-red-950` or `bg-[#0a0a0c]`
 * silently opts that component out. It looks right in dark (where it was
 * written) and renders a near-black slab with pale text on a white page. That is
 * how the light theme rotted the first time: fourteen such escapes across error
 * banners, code blocks and status pills.
 *
 * So the rule is mechanical and enforced here rather than left to review:
 * components use SEMANTIC tokens (danger / warn / success / code / scrim), never
 * a raw palette step of a status hue and never a literal hex.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Status hues carry meaning, so they must be themeable. (Neutral `gray-*` is
 * already remapped to theme vars in tailwind.config, so it is exempt.) */
const STATUS_STEP = /\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:red|amber|emerald|green|yellow|orange|rose|lime|teal)-\d{2,3}\b/g;
/** A literal hex or rgb() in a class or inline style is a theme assumption. */
const LITERAL_COLOR = /(?:bg|text|border)-\[#[0-9a-fA-F]{3,8}\]|\bbg-black\/\d+|\bbg-white\/\d+/g;

describe("theme tokens", () => {
  const files = sourceFiles(SRC);

  it("finds the component tree (guard against an empty sweep passing)", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("uses semantic status tokens, never raw palette steps", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.match(STATUS_STEP) ?? []) {
        offenders.push(`${path.relative(SRC, f)}: ${m}`);
      }
    }
    // A raw step is dark-theme-only by construction. Use bg-danger-bg /
    // text-warn-fg / bg-success and friends instead.
    expect(offenders).toEqual([]);
  });

  it("has no literal hex or black/white scrims outside the token file", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.match(LITERAL_COLOR) ?? []) {
        offenders.push(`${path.relative(SRC, f)}: ${m}`);
      }
    }
    // Overlay scrims use `bg-scrim`; code slabs use `bg-code`.
    expect(offenders).toEqual([]);
  });

  it("defines every semantic token in BOTH themes", () => {
    const css = fs.readFileSync(path.join(SRC, "index.css"), "utf8");
    const dark = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf(':root[data-theme="light"]'));
    const light = css.slice(css.indexOf(':root[data-theme="light"]'));
    const required = [
      "--danger", "--danger-bg", "--danger-bg-strong", "--danger-border",
      "--warn", "--warn-fg", "--warn-bg", "--warn-border",
      "--success", "--success-bg", "--success-border",
      "--code-bg", "--scrim",
    ];
    for (const token of required) {
      // A token defined in only one theme is worse than none: it falls through
      // to the other theme's value and quietly breaks contrast.
      expect(dark, `${token} missing from dark`).toContain(`${token}:`);
      expect(light, `${token} missing from light`).toContain(`${token}:`);
    }
  });
});
