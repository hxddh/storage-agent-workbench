import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "../seed";

/**
 * A visual contact sheet — a development tool, NOT a CI gate.
 *
 * Everything under `e2e/shots/` is excluded from the default Playwright run
 * (`playwright.config.ts` → `testIgnore`) and is reached only through
 * `npm run shots`. That exclusion is deliberate, and the reason is worth
 * writing down because the obvious alternative looks better than it is.
 *
 * Why not `toHaveScreenshot()` as a gate? Because the pixels are not
 * reproducible across the machines that would have to agree on them. This repo
 * is developed in a sandbox that points Playwright at a PREINSTALLED browser
 * (`PW_CHROMIUM_PATH`, currently a `headless_shell` at revision 1194), while CI
 * installs Playwright's own matching Chromium in the default location and
 * leaves that variable unset. Different binary, different font stack, different
 * rasteriser — so a baseline committed from one produces a wall of diffs on the
 * other. The usual escape hatches make it worse rather than better: a generous
 * `maxDiffPixels` stops catching the small regressions that are the whole point
 * of visual testing, and `test.skip()`-ing the gate off-CI turns it into a gate
 * that silently isn't one. This project's stated position is that a check which
 * skips itself quietly has stopped being a check, so it does not get to be one.
 *
 * What this IS: a repeatable way to put every surface that the v0.87.0 design
 * work touched on screen, in BOTH themes, side by side, in one command — so a
 * human can see a regression that no assertion describes ("the separation went
 * flat", "the sticky header overlaps the first row"). It writes PNGs plus an
 * `index.html` contact sheet into `frontend/shots/`, which is gitignored: the
 * output is evidence for a review, never a committed baseline.
 *
 *   cd frontend && npm run shots && open shots/index.html
 *
 * The assertions here exist only to make a capture fail loudly instead of
 * photographing a blank page.
 */

const OUT = path.resolve("shots");
const THEMES = ["dark", "light"] as const;

type Shot = { name: string; theme: string; file: string };
const taken: Shot[] = [];

async function open(page: Page, theme: string, extra: Record<string, string> = {}) {
  await page.addInitScript(
    ([t, kv]) => {
      localStorage.setItem("saw.lang", "en");
      localStorage.setItem("saw.onboarded", "1");
      localStorage.setItem("saw.theme", t as string);
      for (const [k, v] of Object.entries(kv as Record<string, string>)) {
        localStorage.setItem(k, v);
      }
    },
    [theme, extra] as const,
  );
  await page.goto("/");
}

async function shoot(page: Page, name: string, theme: string) {
  const file = `${name}--${theme}.png`;
  await page.screenshot({ path: path.join(OUT, file) });
  taken.push({ name, theme, file });
}

test.beforeAll(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
});

test.use({ viewport: { width: 1440, height: 900 } });

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test("empty state — the first thing a fresh install shows", async ({ page }) => {
      await open(page, theme);
      await expect(page.getByPlaceholder(/Ask Storage Agent/i)).toBeVisible();
      await shoot(page, "01-empty", theme);
    });

    test("a real answer — headings, a wide table, a list", async ({ page }) => {
      const { title } = seedSession(3, undefined, "tall");
      await open(page, theme);
      await page.getByText(title).first().click();
      await expect(page.locator("main").getByText(/ANSWER-/).first()).toBeVisible({
        timeout: 20_000,
      });
      await shoot(page, "02-answer", theme);
    });

    test("a tall table scrolled — the pinned table header mid-thread", async ({ page }) => {
      const { title } = seedSession(3, undefined, "tall");
      await open(page, theme);
      await page.getByText(title).first().click();
      const scroller = page.getByTestId("thread-scroll");
      await expect(scroller).toBeVisible({ timeout: 20_000 });
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight / 2;
      });
      await page.waitForTimeout(400);
      await shoot(page, "03-scrolled", theme);
    });

    test("offline triage — the card a fresh install produces with no provider", async ({ page }) => {
      await open(page, theme);
      const box = page.getByPlaceholder(/Ask Storage Agent/i);
      await box.click();
      await box.fill(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          "<Error><Code>AccessDenied</Code><Message>Access Denied</Message>" +
          "<RequestId>ABC123</RequestId></Error>",
      );
      await box.press("Enter");
      await expect(page.getByText(/AccessDenied/).first()).toBeVisible({ timeout: 20_000 });
      await shoot(page, "04-triage", theme);
    });

    test("first run — the wizard a fresh install opens with", async ({ page }) => {
      await page.addInitScript(([t]) => {
        localStorage.setItem("saw.lang", "en");
        localStorage.removeItem("saw.onboarded");
        localStorage.setItem("saw.theme", t as string);
      }, [theme] as const);
      await page.goto("/");
      await page.waitForTimeout(1200);
      await shoot(page, "06-firstrun", theme);
    });

    test("command palette", async ({ page }) => {
      await open(page, theme);
      await expect(page.getByPlaceholder(/Ask Storage Agent/i)).toBeVisible();
      await page.keyboard.press("ControlOrMeta+k");
      await page.waitForTimeout(400);
      await shoot(page, "07-palette", theme);
    });

    test("keyboard shortcuts sheet", async ({ page }) => {
      await open(page, theme);
      await expect(page.getByPlaceholder(/Ask Storage Agent/i)).toBeVisible();
      await page.locator("body").press("?");
      await page.waitForTimeout(400);
      await shoot(page, "08-shortcuts", theme);
    });

    test("find in an investigation", async ({ page }) => {
      const { title } = seedSession(8, undefined, "tall");
      await open(page, theme);
      await page.getByText(title).first().click();
      await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 20_000 });
      await page.keyboard.press("ControlOrMeta+f");
      await page.waitForTimeout(300);
      await page.keyboard.type("bucket-003");
      await page.waitForTimeout(700);
      await shoot(page, "09-find", theme);
    });

    test("session inspector", async ({ page }) => {
      const { title } = seedSession(6, undefined, "tall");
      await open(page, theme);
      await page.getByText(title).first().click();
      await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 20_000 });
      await page.getByTestId("open-inspector").click();
      await page.waitForTimeout(700);
      await shoot(page, "10-inspector", theme);
    });

    test("the turn trace, expanded", async ({ page }) => {
      const { title } = seedSession(4, undefined, "tall");
      await open(page, theme);
      await page.getByText(title).first().click();
      await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 20_000 });
      await page.getByTestId("turn-footer-toggle").last().click();
      await page.waitForTimeout(500);
      await shoot(page, "11-trace", theme);
    });

    test("the rail collapsed", async ({ page }) => {
      const { title } = seedSession(4, undefined, "tall");
      await open(page, theme);
      await page.getByText(title).first().click();
      await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: /collapse sidebar/i }).first().click();
      await page.waitForTimeout(400);
      await shoot(page, "12-rail-collapsed", theme);
    });

    test("a narrow window", async ({ page }) => {
      const { title } = seedSession(4, undefined, "tall");
      await open(page, theme);
      await page.setViewportSize({ width: 900, height: 800 });
      await page.getByText(title).first().click();
      await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(500);
      await shoot(page, "13-narrow", theme);
    });

    test("settings — the drawer over the thread", async ({ page }) => {
      await open(page, theme);
      await page.getByRole("button", { name: /settings/i }).first().click();
      await expect(page.getByText(/settings & providers/i)).toBeVisible();
      await shoot(page, "05-settings", theme);
    });
  });
}

test.afterAll(() => {
  // One page, both themes on the same row, so the pair is compared by eye
  // rather than by flipping between two files.
  const names = [...new Set(taken.map((s) => s.name))].sort();
  const rows = names
    .map((name) => {
      const cells = THEMES.map((theme) => {
        const shot = taken.find((s) => s.name === name && s.theme === theme);
        return shot
          ? `<figure><img src="${shot.file}" alt="${name} ${theme}"><figcaption>${theme}</figcaption></figure>`
          : `<figure class="missing"><figcaption>${theme} — not captured</figcaption></figure>`;
      }).join("");
      return `<section><h2>${name}</h2><div class="pair">${cells}</div></section>`;
    })
    .join("\n");
  fs.writeFileSync(
    path.join(OUT, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Storage Agent Workbench — visual contact sheet</title>
<style>
 body{margin:0;padding:24px;background:#111418;color:#e6e8eb;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
 h1{font-size:18px;margin:0 0 4px} p.note{color:#9aa4af;margin:0 0 24px;max-width:70ch}
 section{margin:0 0 32px} h2{font-size:14px;font-weight:600;color:#9aa4af;margin:0 0 8px}
 .pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
 figure{margin:0} figcaption{font-size:12px;color:#9aa4af;padding:4px 2px}
 img{width:100%;display:block;border:1px solid #2a3138;border-radius:6px}
 .missing{border:1px dashed #2a3138;border-radius:6px;padding:24px;color:#7a848f}
</style>
<h1>Visual contact sheet</h1>
<p class="note">Generated by <code>npm run shots</code>. This is review evidence, not a
baseline — nothing here is asserted against, and the pixels are not reproducible
across the sandbox browser and CI's. Look for what an assertion cannot describe:
surface separation, sticky-header overlap, alignment, crowding.</p>
${rows}
`,
  );
  console.log(`\n  ${taken.length} shots → ${path.join(OUT, "index.html")}\n`);
});
