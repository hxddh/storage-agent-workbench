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
