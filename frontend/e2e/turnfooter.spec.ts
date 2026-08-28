import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

/**
 * What a finished turn says about itself, on the real stack.
 *
 * The turn footer is the single affordance under every answer: what ran, how
 * long it took, what it cost, and — since v0.56.0 — a row that opens to the
 * call's real persisted input and output. Every piece was unit-tested against
 * props. Nothing checked that the numbers reach the screen from the database,
 * or that opening a row fetches anything.
 */

const thread = (page: Page) => page.locator("main");

async function open(page: Page, exchanges = 3) {
  const { title } = seedSession(exchanges);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await page.getByText(title).first().click();
  await expect(thread(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });
}

test.describe("the turn footer", () => {
  test("reports the measured cost of the turn, not dashes", async ({ page }) => {
    await open(page);
    const footer = page.getByTestId("turn-footer-toggle").last().locator("xpath=..");
    // 1200 in / 300 out / 2400 ms were persisted by the seed.
    await expect(footer).toContainText("1.2k");
    await expect(footer).toContainText("300");
    await expect(footer).toContainText(/2\.4\s*s/);
  });

  test("expands to the trace in execution order", async ({ page }) => {
    await open(page);
    await page.getByTestId("turn-footer-toggle").last().click();
    await expect(page.getByTestId("footer-row-open").last()).toBeVisible();
    await expect(thread(page).getByText("head_bucket").last()).toBeVisible();
  });

  test("a trace row opens to the call's real persisted input and output", async ({ page }) => {
    await open(page);
    await page.getByTestId("turn-footer-toggle").last().click();
    await page.getByTestId("footer-row-open").last().click();
    // Fetched from /sessions/{id}/activity/{call_id} — neither string is in the
    // thread payload, so seeing them proves the round trip happened.
    await expect(thread(page).getByText(/"status"\s*:\s*200/).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("inspect opens the session inspector", async ({ page }) => {
    await open(page);
    await thread(page).getByRole("button", { name: /inspect/i }).last().click();
    await expect(page.getByText(/head_bucket/).first()).toBeVisible({ timeout: 15_000 });
  });
});

/**
 * Opening a step shows you the step.
 *
 * The detail is fetched, so it arrives a tick after the click and can be several
 * hundred pixels tall. On a turn at the bottom of the thread — where a finished
 * turn always is — it therefore unfolded straight past the bottom of the reading
 * area. Measured before the fix: the row's payload rendered 231px tall with its
 * bottom at 995px in an area that ends at 790px, so 205px of the answer to the
 * question you had just asked was below the fold, with nothing saying so.
 *
 * `block: "nearest"` on a ResizeObserver, not a one-shot scroll: a single scroll
 * on the next frame moves a row that has not been filled in yet, and a row
 * already fully visible must not move at all.
 */
test("an opened tool call is brought into view, not left below the fold", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { title } = seedSession(4, `open-call ${Date.now()}`, "tall");
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await page.getByText(title, { exact: true }).first().click();
  await expect(page.locator(".thread-item").first()).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("turn-footer-toggle").last().click();
  await page.getByTestId("footer-row-open").last().click();
  // The payload is fetched; wait for the row to actually carry it.
  await expect(page.getByText(/RETURNED|SENT/i).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);

  const m = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="footer-row-open"]') as HTMLElement;
    const li = row.closest("li") as HTMLElement;
    const sc = document.querySelector('[data-testid="thread-scroll"]') as HTMLElement;
    return {
      height: Math.round(li.getBoundingClientRect().height),
      bottom: Math.round(li.getBoundingClientRect().bottom),
      areaBottom: Math.round(sc.getBoundingClientRect().bottom),
    };
  });
  // It really did open — otherwise "nothing below the fold" is trivially true.
  expect(m.height).toBeGreaterThan(100);
  expect(m.bottom).toBeLessThanOrEqual(m.areaBottom + 1);
});
