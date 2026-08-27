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
      "--syn-str", "--syn-num", "--syn-kw", "--syn-com", "--syn-name", "--syn-tag", "--syn-punct",
    ];
    for (const token of required) {
      // A token defined in only one theme is worse than none: it falls through
      // to the other theme's value and quietly breaks contrast.
      expect(dark, `${token} missing from dark`).toContain(`${token}:`);
      expect(light, `${token} missing from light`).toContain(`${token}:`);
    }
  });
});

/**
 * Contrast is measurable, so it is checked rather than eyeballed.
 *
 * The semantic tints were constructed, not sampled from a design, and the
 * neutral ramp carries real information (the per-turn metrics footer, every
 * timestamp). WCAG's 3.0:1 floor for UI text and 4.5:1 for body text is the
 * bar; a token that quietly slips under it looks "subtle" to whoever picked it
 * and unreadable to everyone else.
 */
describe("contrast", () => {
  const css = fs.readFileSync(path.join(SRC, "index.css"), "utf8");

  const block = (sel: string) => {
    const i = css.indexOf(sel);
    const j = css.indexOf("}", i);
    const out: Record<string, string> = {};
    for (const m of css.slice(i, j).matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
  };

  type RGBA = [number, number, number, number];
  const parse = (c: string): RGBA => {
    if (c.startsWith("#")) {
      let h = c.slice(1);
      if (h.length === 3) h = [...h].map((x) => x + x).join("");
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
    }
    const p = c.replace(/rgba?\(|\)/g, "").split(/[\s,]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  };
  const over = (fg: RGBA, bg: RGBA): RGBA =>
    [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as RGBA;
  const lum = (c: RGBA) => {
    const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: RGBA, b: RGBA) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  for (const [theme, sel] of [["dark", ':root[data-theme="dark"]'], ["light", ':root[data-theme="light"]']] as const) {
    const v = block(sel);
    const canvas = parse(v["--canvas"]);

    it(`${theme}: status text clears AA on its own surface`, () => {
      for (const [fg, bg] of [["--danger", "--danger-bg"], ["--warn-fg", "--warn-bg"], ["--success", "--success-bg"]]) {
        const surface = over(parse(v[bg]), canvas);
        expect(ratio(over(parse(v[fg]), surface), surface), `${theme} ${fg}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${theme}: the faintest neutral still clears the 3.0 UI floor`, () => {
      // gray-600 carries the metrics footer and timestamps — quiet, but not
      // decorative, so it may not fall below the floor.
      expect(ratio(parse(v["--gray-600"]), canvas), theme).toBeGreaterThanOrEqual(3.0);
      expect(ratio(parse(v["--gray-500"]), canvas), theme).toBeGreaterThanOrEqual(3.0);
    });

    it(`${theme}: every syntax slot clears AA on the code slab`, () => {
      // Syntax colour is body text on a coloured ground — the slab is --code-bg,
      // not the canvas. A slot picked in dark and reused in light is exactly how
      // a highlighter turns a white page into pastel mush.
      const slab = over(parse(v["--code-bg"]), canvas);
      for (const slot of ["str", "num", "kw", "com", "name", "tag", "punct"]) {
        const c = parse(v[`--syn-${slot}`]);
        expect(ratio(over(c, slab), slab), `${theme} --syn-${slot}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${theme}: the syntax slots are distinguishable from each other`, () => {
      // Two slots that read as the same colour convey nothing; the point of the
      // palette is that a key is not a value.
      const slots = ["str", "num", "kw", "name", "tag"];
      for (let a = 0; a < slots.length; a++) {
        for (let b = a + 1; b < slots.length; b++) {
          const d = Math.abs(lum(parse(v[`--syn-${slots[a]}`])) - lum(parse(v[`--syn-${slots[b]}`])));
          const hueApart =
            parse(v[`--syn-${slots[a]}`]).slice(0, 3).some((ch, i) => Math.abs(ch - parse(v[`--syn-${slots[b]}`])[i]) > 40);
          expect(d > 0.03 || hueApart, `${theme} ${slots[a]} vs ${slots[b]}`).toBe(true);
        }
      }
    });

    it(`${theme}: the layered surfaces are actually distinguishable from each other`, () => {
      // Depth is carried by four surfaces — canvas < sidebar/panel < elevated <
      // hover — and in dark it works, because each step is visibly lighter than
      // the last. The light theme was written by inverting the FOREGROUNDS and
      // leaving the grounds near-white, so it arrived with `--panel` and
      // `--canvas` both at #ffffff: a card had zero surface distinction from the
      // page behind it and depended entirely on a 1px border to exist. The
      // sidebar was #f7f7f8 against a #ffffff canvas, a separation of well under
      // 1%, which reads as a rendering artefact rather than a boundary.
      //
      // CIELAB lightness, not a relative-luminance delta: luminance compresses
      // at the dark end, so an absolute delta calls a near-black stack identical
      // when it is perfectly legible, and calls a near-white one fine when it is
      // not. L* is perceptually uniform, so one floor works for both themes.
      // (Measured before this gate existed: dark canvas->sidebar was 1.26 and
      // light canvas->panel was 0.00.)
      const lstar = (c: string) => {
        const Y = lum(parse(v[c]));
        const d = 6 / 29;
        return 116 * (Y > d ** 3 ? Math.cbrt(Y) : Y / (3 * d * d) + 4 / 29) - 16;
      };
      const step = (a: string, b: string) => Math.abs(lstar(a) - lstar(b));
      const FLOOR = 2.5;
      for (const [a, b] of [
        ["--canvas", "--sidebar"],
        ["--canvas", "--panel"],
        ["--panel", "--elevated"],
        ["--elevated", "--hover"],
      ]) {
        expect(step(a, b), `${theme} ${a} vs ${b}`).toBeGreaterThanOrEqual(FLOOR);
      }
    });

    it(`${theme}: the neutral ramp keeps its ordering`, () => {
      // 100 is strongest through 700 faintest; an out-of-order step silently
      // inverts emphasis wherever it is used.
      const ramp = [100, 200, 300, 400, 500, 600, 700].map((n) => ratio(parse(v[`--gray-${n}`]), canvas));
      for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeLessThan(ramp[i - 1]);
    });
  }
});

describe("the keyboard focus ring (v0.61.0)", () => {
  const css = fs.readFileSync(path.join(SRC, "index.css"), "utf8");
  // Located by the START of the selector, not by the literal `:focus-visible {`.
  // The selector grew a `:not(...)` for the documented opt-out and the old
  // exact-match extractor silently sliced from -1, which makes every assertion
  // below read a garbage string.
  const start = css.search(/^:focus-visible[^{]*\{/m);
  const rule = css.slice(start, css.indexOf("}", start));

  it("exists at all", () => {
    expect(rule).toContain("box-shadow");
  });

  it("does not force a corner radius on the elements it decorates", () => {
    // It used to hardcode `border-radius: 0.5rem`, which is right for exactly
    // one shape. Measured across the focusable elements, 24 were a different
    // one — 10 `rounded-full` pills, 8 `rounded-md`, 6 `rounded` — so tabbing
    // drew an 8px-cornered box around a fully round button, every stop.
    //
    // box-shadow already follows the element's own border-radius, so declaring
    // nothing is what makes the ring follow the shape.
    expect(rule).not.toMatch(/border-radius/);
  });

  it("can only be opted out of through the one documented attribute", () => {
    // A component cannot decline this ring with a utility class: the rule is
    // unlayered and Tailwind v4 emits utilities inside `@layer utilities`, so
    // unlayered wins regardless of specificity and `focus-visible:shadow-none`
    // is inert. The attribute is the supported way, and it exists for one case
    // — an element whose focus is already drawn by an ancestor.
    expect(rule).toContain('data-focus-ring="container"');
  });

  it("is not opted out of widely", () => {
    // Every use is an element choosing to show no ring of its own, which is only
    // honest when something else shows one. Keep that reviewable: if this count
    // grows, the ring is being switched off rather than delegated.
    const users = sourceFiles(SRC).filter((f) =>
      fs.readFileSync(f, "utf8").includes('data-focus-ring="container"'),
    );
    expect(users.map((f) => path.basename(f))).toEqual(["Composer.tsx"]);
  });

  it("still suppresses the default outline it replaces", () => {
    // Dropping the radius must not also drop the reason the rule exists.
    expect(rule).toContain("outline: none");
  });
});
