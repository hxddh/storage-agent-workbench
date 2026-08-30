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
const STATUS_STEP = /\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:red|amber|emerald|green|yellow|orange|rose|lime|teal|violet|indigo|purple|fuchsia|pink|sky|cyan|blue)-\d{2,3}\b/g;
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
      "--shadow-elev", "--shadow-pop", "--shadow-glow",
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

    it(`${theme}: every ink step clears AA on the WORST surface it can land on`, () => {
      // This assertion replaces one that was written to pass.
      //
      // The old version held gray-500 and gray-600 to 3.0:1 — WCAG's floor for
      // a UI COMPONENT, not for text — and measured them against the canvas
      // only. Its own comment said gray-600 "carries the metrics footer and
      // timestamps, quiet but not decorative", which is to say: content, which
      // needs 4.5. So the token test was green while the rendered product was
      // being called unreadable, and it was green for two separate reasons —
      // the wrong floor, and the wrong ground.
      //
      // Text does not only appear on the canvas. It appears on a hovered rail
      // row, inside a panel, on an elevated card. The lightest of those (in
      // dark; the darkest in light) is `--hover`, so that is the ground every
      // ink step is judged against. Measured on what this replaces, against
      // that ground: gray-600 2.29:1, gray-700 2.05:1.
      //
      // e2e/contrast.spec.ts is the other half of this and the one that cannot
      // be gamed: it audits every text node the app actually renders, so a
      // token used somewhere this table never imagined is still caught.
      const worst = parse(v["--hover"]);
      for (const n of [100, 200, 300, 400, 500]) {
        expect(
          ratio(parse(v[`--gray-${n}`]), worst),
          `${theme} --gray-${n} on --hover`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${theme}: the accent can carry its own label`, () => {
      // The primary action is a filled accent button. Whatever ink sits on it
      // has to be readable ON it — and white was not: 3.09:1 in dark, which
      // made "Add model provider" the least readable string on the screen.
      const fill = parse(v["--accent"]);
      expect(ratio(parse(v["--accent-fg"]), fill), `${theme} --accent-fg`).toBeGreaterThanOrEqual(4.5);
      // …and the accent is also used AS text, on the canvas.
      expect(ratio(fill, canvas), `${theme} --accent as ink`).toBeGreaterThanOrEqual(4.5);
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

    it(`${theme}: every neutral sits on ONE hue axis`, () => {
      // The un-nameable "cheap" quality of a screen where nothing is technically
      // wrong. Measured on what this replaced: the surfaces sat at hue 281-290
      // and the text ramp at 269-271 — two different greys pulling opposite
      // ways, so text never quite belonged to the surface under it. A neutral
      // is allowed to be a colour; it is not allowed to be a DIFFERENT colour
      // from the neutral next to it.
      //
      // Hue is meaningless below a chroma floor (pure white and pure black have
      // no hue at all), so only tokens with real chroma are judged.
      const lch = (hex: string) => {
        const [r, g, b] = parse(hex).map((c: number) => {
          const s = c / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
        const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
        const fx = f(X / 0.95047);
        const fy = f(Y);
        const fz = f(Z / 1.08883);
        const A = 500 * (fx - fy);
        const B = 200 * (fy - fz);
        return { c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
      };
      const names = [
        "--canvas", "--sidebar", "--panel", "--elevated", "--hover", "--edge", "--edge-strong",
        "--gray-100", "--gray-200", "--gray-300", "--gray-400", "--gray-500",
      ];
      const hues = names
        .map((n) => ({ n, ...lch(v[n]) }))
        .filter((x) => x.c >= 1.5);
      expect(hues.length, `${theme}: too few tinted neutrals to judge`).toBeGreaterThan(6);
      const spread = (a: number, b: number) => {
        const d = Math.abs(a - b) % 360;
        return d > 180 ? 360 - d : d;
      };
      for (const x of hues) {
        expect(spread(x.h, 268), `${theme} ${x.n} hue ${x.h.toFixed(1)}`).toBeLessThanOrEqual(12);
      }
    });

    it(`${theme}: the surface ladder has somewhere to climb`, () => {
      // Adjacent steps clearing the floor is not the same as the stack having
      // range. Before this, all four dark surfaces lived inside 9.2 L* at the
      // very bottom of the scale: every pair passed, and the result still read
      // flat because there was nowhere for depth to happen.
      const lstar = (c: string) => {
        const Y = lum(parse(v[c]));
        const d = 6 / 29;
        return 116 * (Y > d ** 3 ? Math.cbrt(Y) : Y / (3 * d * d) + 4 / 29) - 16;
      };
      const span = Math.abs(lstar("--canvas") - lstar("--hover"));
      expect(span, `${theme}: canvas..hover span`).toBeGreaterThanOrEqual(12);
    });

    it(`${theme}: the neutral ramp keeps its ordering`, () => {
      // 100 is strongest through 500 faintest; an out-of-order step silently
      // inverts emphasis wherever it is used. (600 and 700 were removed in
      // v0.90.0 — they existed only to make text disappear.)
      const ramp = [100, 200, 300, 400, 500].map((n) => ratio(parse(v[`--gray-${n}`]), canvas));
      for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeLessThan(ramp[i - 1]);
    });

    it(`${theme}: the ramp that was removed stays removed`, () => {
      // A reintroduced --gray-600 would sail past every assertion above (they
      // enumerate 100-500) and land straight back in the trace rows.
      expect(v["--gray-600"], `${theme} --gray-600 is back`).toBeUndefined();
      expect(v["--gray-700"], `${theme} --gray-700 is back`).toBeUndefined();
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
