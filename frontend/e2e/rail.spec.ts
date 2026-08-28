import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

/**
 * Managing investigations from persistent navigation, on the real stack.
 *
 * These are product contracts rather than component-callback tests: every
 * mutation hits the real sidecar and the navigation must continue to expose the
 * investigation as a durable unit of work, not merely as chat history.
 */

const rail = (page: Page) => page.getByTestId("session-rail");
const thread = (page: Page) => page.locator("main");
async function open(page: Page, exchanges = 3): Promise<string> {
  const { title } = seedSession(exchanges);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(rail(page).getByText(title).first()).toBeVisible({ timeout: 20_000 });
  return title;
}

/** Open the ⋯ menu on the first row carrying `title`. */
async function menu(page: Page, title: string) {
  const row = rail(page).getByText(title).first();
  await row.hover();
  await row.locator("xpath=ancestor::*[.//button][1]").getByRole("button", { name: /more/i })
    .first()
    .click();
}

test.describe("investigation navigation", () => {
  test("rows expose investigation scope and durable work counts instead of chat-only metadata", async ({ page }) => {
    const TITLE = await open(page);
    await expect(rail(page)).toHaveAttribute("data-navigation", "investigations");
    const row = rail(page).getByTestId("investigation-row").filter({ hasText: TITLE }).first();
    await expect(row).toContainText("General storage investigation");
    await expect(row).toContainText("0F · 0R");
  });

  test("renaming it changes navigation AND the workbench identity", async ({ page }) => {
    const TITLE = await open(page);
    await rail(page).getByText(TITLE).first().click();
    await expect(thread(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });

    await menu(page, TITLE);
    await page.getByText("Rename", { exact: true }).click();
    const field = rail(page).locator("input").last();
    await field.fill("403 on acme-logs");
    await field.press("Enter");

    await expect(rail(page).getByText("403 on acme-logs")).toBeVisible({ timeout: 15_000 });
    await expect(thread(page).getByText("403 on acme-logs")).toBeVisible({ timeout: 15_000 });
  });

  test("duplicating it produces a second investigation with the same history", async ({ page }) => {
    const TITLE = await open(page);
    await menu(page, TITLE);
    await page.getByText("Duplicate", { exact: true }).click();

    await expect(rail(page).getByText(TITLE)).toHaveCount(2, { timeout: 15_000 });
    await expect(thread(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 15_000 });
  });

  test("deleting the OPEN investigation leaves a usable workbench", async ({ page }) => {
    const TITLE = await open(page);
    await rail(page).getByText(TITLE).first().click();
    await expect(thread(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });

    await menu(page, TITLE);
    await page.getByText("Delete", { exact: true }).click();
    await page.getByRole("button", { name: /^delete$/i }).last().click();

    await expect(rail(page).getByText(TITLE)).toHaveCount(0, { timeout: 15_000 });
    await expect(thread(page).getByText(/How can I help/i)).toBeVisible({ timeout: 15_000 });
    await expect(thread(page).getByText(/Couldn't load/i)).toHaveCount(0);
  });

  test("deleting it does not resurrect it on the next launch", async ({ page }) => {
    const TITLE = await open(page);
    await rail(page).getByText(TITLE).first().click();
    await expect(thread(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });

    await menu(page, TITLE);
    await page.getByText("Delete", { exact: true }).click();
    await page.getByRole("button", { name: /^delete$/i }).last().click();
    await expect(rail(page).getByText(TITLE)).toHaveCount(0, { timeout: 15_000 });

    await page.reload();
    await expect(thread(page).getByText(/How can I help/i)).toBeVisible({ timeout: 20_000 });
    await expect(thread(page).getByText(/Couldn't load/i)).toHaveCount(0);
  });

  test("archiving it takes it out of the active investigation list", async ({ page }) => {
    const TITLE = await open(page);
    await menu(page, TITLE);
    await page.getByText("Archive", { exact: true }).click();
    await expect(rail(page).getByText(TITLE)).toHaveCount(0, { timeout: 15_000 });
  });

  test("server-backed search narrows investigations by title or message content", async ({ page }) => {
    const TITLE = await open(page);
    const search = page.getByPlaceholder(/Search investigations/i);
    await search.fill("seeded");
    await expect(rail(page).getByText(TITLE).first()).toBeVisible();
    await search.fill("no-such-investigation");
    await expect(rail(page).getByText(TITLE)).toHaveCount(0, { timeout: 10_000 });
  });
});
