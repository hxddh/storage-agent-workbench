import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

/**
 * Does the screen pass? Not: does the palette pass.
 *
 * `theme.tokens.test.ts` checks TOKEN PAIRS — gray-400 against canvas, and so
 * on. Every pair it knows about cleared its floor while the rendered product
 * was still being called illegible, because a token pair is a hypothesis about
 * the screen and this is the screen. The two differ wherever a token lands on a
 * ground the pair table never imagined: gray-500 on `--panel` inside a drawer,
 * a status foreground on its own tinted surface, a hairline rule chosen against
 * canvas and then drawn on an elevated card.
 *
 * So this walks the real DOM in a real browser, resolves every text node's
 * effective foreground and its effective background (up the ancestor chain,
 * compositing alpha as it goes), and applies WCAG 2.1 AA: 4.5:1 for body text,
 * 3.0:1 for large text (>=24px, or >=18.66px bold). No sampling, no
 * anti-aliasing guesswork — the exact computed values the compositor was given.
 */

const AA_BODY = 4.5;
const AA_LARGE = 3.0;

/** Text that is deliberately quiet and is not content: placeholders and
 * disabled controls, which WCAG itself exempts. Anything else must pass. */
const EXEMPT = "[data-contrast-exempt]";

type Violation = {
  ratio: number;
  need: number;
  fg: string;
  bg: string;
  px: number;
  weight: string;
  text: string;
  where: string;
};

async function audit(page: Page): Promise<Violation[]> {
  return page.evaluate(
    ({ AA_BODY, AA_LARGE, EXEMPT }) => {
      const lin = (v: number) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);

      // Colour parsing is the browser's job, not a regex's.
      //
      // The first version of this auditor matched digits out of the computed
      // string and read them as RGB. Tailwind's opacity modifiers make Chromium
      // report `oklab(0.930348 -0.000788 -0.008662 / 0.992963)`, so the active
      // rail row came back as rgb(3,2,2) — a near-black ground in the LIGHT
      // theme — and the auditor reported two failures that were its own. Paint
      // the colour onto a canvas instead: any syntax the browser accepts,
      // composited by the same code that composites the page.
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      const paint = (color: string, onto: number[], alpha = 1): number[] => {
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgb(${onto[0]},${onto[1]},${onto[2]})`;
        ctx.fillRect(0, 0, 1, 1);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        ctx.globalAlpha = 1;
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      /** Opaque = paints the same over black as over white. */
      const isOpaque = (color: string) => {
        const a = paint(color, [0, 0, 0]);
        const b = paint(color, [255, 255, 255]);
        return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
      };
      /** The colour actually behind `el`, compositing every translucent layer. */
      const groundOf = (el: Element): number[] => {
        const layers: string[] = [];
        let n: Element | null = el;
        while (n) {
          const bg = getComputedStyle(n).backgroundColor;
          layers.push(bg);
          if (isOpaque(bg)) break;
          n = n.parentElement;
        }
        // Nothing opaque all the way up: the browser paints white behind it.
        let out = [255, 255, 255];
        for (let i = layers.length - 1; i >= 0; i--) out = paint(layers[i], out);
        return out;
      };

      const out: Violation[] = [];
      const seen = new Set<string>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = (node.nodeValue ?? "").trim();
        const el = node.parentElement;
        node = walker.nextNode();
        if (!el || text.length === 0) continue;
        if (el.closest(EXEMPT)) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // Off-screen or screen-reader-only text paints nothing.
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const opacity = Number(cs.opacity);
        if (opacity === 0) continue;

        const px = parseFloat(cs.fontSize);
        const weight = cs.fontWeight;
        const bold = Number(weight) >= 700;
        const need = px >= 24 || (bold && px >= 18.66) ? AA_LARGE : AA_BODY;

        const ground = groundOf(el);
        // Ink is composited the same way: its own alpha, times the element's
        // opacity, over whatever is actually behind it.
        const fg = paint(cs.color, ground, opacity);

        const l1 = Math.max(lum(fg), lum(ground));
        const l2 = Math.min(lum(fg), lum(ground));
        const ratio = (l1 + 0.05) / (l2 + 0.05);
        if (ratio >= need) continue;

        const where = `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(/\s+/).slice(0, 3).join(".")}`;
        const key = `${where}|${Math.round(ratio * 100)}|${px}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ratio: Math.round(ratio * 100) / 100,
          need,
          fg: `rgb(${fg.map(Math.round)})`,
          bg: `rgb(${ground.map(Math.round)})`,
          px,
          weight,
          text: text.slice(0, 48),
          where,
        });
      }
      return out.sort((a, b) => a.ratio - b.ratio);
    },
    { AA_BODY, AA_LARGE, EXEMPT },
  );
}

function report(name: string, v: Violation[]): string {
  return (
    `${v.length} text node(s) below AA on ${name}:\n` +
    v
      .map(
        (x) =>
          `  ${String(x.ratio).padStart(5)}:1 (needs ${x.need})  ${x.px}px/${x.weight}  ` +
          `${x.fg} on ${x.bg}  ${x.where}\n      "${x.text}"`,
      )
      .join("\n")
  );
}

async function boot(page: Page, theme: "dark" | "light", seeded: boolean) {
  const seed = seeded ? seedSession(3, `contrast ${theme} ${Date.now()}`, "tall") : null;
  await page.addInitScript(
    (t) => {
      localStorage.setItem("saw.lang", "en");
      localStorage.setItem("saw.onboarded", "1");
      localStorage.setItem("saw.theme", t);
    },
    theme,
  );
  await page.goto("/");
  await expect(page.getByPlaceholder(/Ask Storage Agent/i)).toBeVisible({ timeout: 30_000 });
  if (seed) {
    await page.getByText(seed.title).first().click();
    await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 30_000 });
  }
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`every word on screen is readable — ${theme}`, () => {
    test("the start surface", async ({ page }) => {
      await boot(page, theme, false);
      const v = await audit(page);
      expect(v, report(`start surface (${theme})`, v)).toEqual([]);
    });

    test("an answer, with its table, trace and footer", async ({ page }) => {
      test.setTimeout(90_000);
      await boot(page, theme, true);
      const v = await audit(page);
      expect(v, report(`answer (${theme})`, v)).toEqual([]);
    });

    test("the settings drawer", async ({ page }) => {
      await boot(page, theme, false);
      await page.getByTestId("rail-settings").click();
      await expect(page.getByText(/settings & providers/i)).toBeVisible();
      await page.waitForTimeout(500); // let the open animation settle
      const v = await audit(page);
      expect(v, report(`settings (${theme})`, v)).toEqual([]);
    });
  });
}
