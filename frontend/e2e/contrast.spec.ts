import { expect, test, type Page } from "@playwright/test";
import { boot as bootApp, delegate, reset, settled } from "./app";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

/**
 * Audit the rendered Agent product, not token-pair assumptions. Every visible
 * text node must meet WCAG AA on the background the browser actually paints.
 */
const AA_BODY = 4.5;
const AA_LARGE = 3.0;
// WCAG 1.4.3 exempts inactive controls: a disabled button is not text to read.
const EXEMPT = "[data-contrast-exempt], button:disabled, [aria-disabled=\"true\"]";

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
      const isOpaque = (color: string) => {
        const a = paint(color, [0, 0, 0]);
        const b = paint(color, [255, 255, 255]);
        return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
      };
      const groundOf = (el: Element): number[] => {
        const layers: string[] = [];
        let n: Element | null = el;
        while (n) {
          const bg = getComputedStyle(n).backgroundColor;
          layers.push(bg);
          if (isOpaque(bg)) break;
          n = n.parentElement;
        }
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
        if (!el || text.length === 0 || el.closest(EXEMPT)) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const opacity = Number(cs.opacity);
        if (opacity === 0) continue;

        const px = parseFloat(cs.fontSize);
        const weight = cs.fontWeight;
        const bold = Number(weight) >= 700;
        const need = px >= 24 || (bold && px >= 18.66) ? AA_LARGE : AA_BODY;
        const ground = groundOf(el);
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
    v.map((x) =>
      `  ${String(x.ratio).padStart(5)}:1 (needs ${x.need})  ${x.px}px/${x.weight}  ` +
      `${x.fg} on ${x.bg}  ${x.where}\n      "${x.text}"`,
    ).join("\n")
  );
}

async function boot(page: Page, theme: "dark" | "light", seeded: boolean) {
  await reset();
  await bootApp(page, { theme });
  if (!seeded) return;
  const model = await startFakeModel([
    toolTurn("list_uploaded_files", {}),
    toolTurn("record_conclusion", { answer: "Nothing is attached yet.", next_steps: ["Attach a log"],
      findings: [{ title: "No evidence", severity: "high", detail: "Attach an access log." },
        { title: "Low", severity: "low", detail: "" }, { title: "Info", severity: "info", detail: "" }] }),
    textTurn("| a | b |\n|---|---|\n| 1 | 2 |"),
  ]);
  const id = await useFakeModel(model.baseUrl);
  await delegate(page, `contrast ${theme}`);
  await expect(page.getByTestId("result")).toBeVisible({ timeout: 30_000 });
  await settled(page);
  await dropModelProvider(id);
  await model.close();
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`every word on screen is readable — ${theme}`, () => {
    test("the home", async ({ page }) => {
      await boot(page, theme, false);
      const v = await audit(page);
      expect(v, report(`home (${theme})`, v)).toEqual([]);
    });

    test("a Result with findings", async ({ page }) => {
      test.setTimeout(90_000);
      await boot(page, theme, true);
      const v = await audit(page);
      expect(v, report(`Result (${theme})`, v)).toEqual([]);
    });

    test("Settings", async ({ page }) => {
      await boot(page, theme, false);
      await page.getByTestId("open-settings").click();
      await expect(page.getByTestId("settings")).toBeVisible();
      await page.waitForTimeout(500);
      const v = await audit(page);
      expect(v, report(`settings (${theme})`, v)).toEqual([]);
    });
  });
}
