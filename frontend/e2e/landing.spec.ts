import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

/**
 * v2.0 — opening a Task puts you on its Result, at the top, and nothing moves
 * you after that.
 *
 * Until v1.19 a Task opened at the END of its transcript, and a long history
 * of real answers (heading, paragraphs, a 24-row table — the "tall" shape)
 * meant a convergence loop chasing a bottom that kept moving, a pin detector,
 * and a *Jump to latest* rescue. Result-first removes the chase: the latest
 * Work Result is the first thing in the document, so the Task opens at
 * scrollTop 0, and the reader's scroll position is theirs.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const scroller = (page: Page) => page.getByTestId("task-scroll");

async function openSeeded(page: Page, title: string) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  await page.getByText(title, { exact: true }).first().click();
  await expect(page.getByTestId("task-result")).toBeVisible({ timeout: 20_000 });
}

const scrollTop = (page: Page) => scroller(page).evaluate((el) => Math.round(el.scrollTop));

test.describe("a long Task of realistically-sized answers", () => {
  test("opens on its Result at the top, and stays there", async ({ page }) => {
    const { title } = seedSession(40, `landing tall ${Date.now()}`, "tall", true);
    await openSeeded(page, title);

    await expect(page.getByTestId("result-conclusion")).toBeVisible();
    expect(await scrollTop(page)).toBe(0);
    // The failure mode this replaces was a landing that kept moving; the
    // position must hold while the document finishes laying out.
    await page.waitForTimeout(2000);
    expect(await scrollTop(page)).toBe(0);
    const inView = await page.getByTestId("result-answer").evaluate((el) => {
      const sc = document.querySelector('[data-testid="task-scroll"]') as HTMLElement;
      const a = sc.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.top >= a.top && r.bottom <= a.bottom;
    });
    expect(inView).toBe(true);
    await expect(page.getByTestId("jump-to-latest")).toHaveCount(0);
  });

  test("the Result is the latest Work Result; the Work log below holds the turns", async ({ page }) => {
    const { title } = seedSession(40, `landing latest ${Date.now()}`, "tall", true);
    await openSeeded(page, title);

    await expect(page.getByTestId("task-result").getByTestId("turn-answer")).toContainText("ANSWER-39");
    const log = page.getByTestId("task-log");
    await expect(log).toBeAttached();
    // The latest turn in the log points up to the Result instead of repeating it.
    await expect(log.getByTestId("log-result-above")).toHaveCount(1);
    await expect(log.getByTestId("turn-answer")).toHaveCount(0);
  });

  test("the reader's scroll position is theirs: nothing pulls it back", async ({ page }) => {
    const { title } = seedSession(12, `landing hold ${Date.now()}`, "tall", true);
    await openSeeded(page, title);

    await scroller(page).evaluate((el) => { el.scrollTop = Math.round(el.scrollHeight / 2); });
    const placed = await scrollTop(page);
    expect(placed).toBeGreaterThan(0);
    await page.waitForTimeout(2000);
    expect(Math.abs((await scrollTop(page)) - placed)).toBeLessThanOrEqual(2);
  });
});
