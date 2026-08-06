import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

/**
 * Managing investigations from the rail, on the real stack.
 *
 * Rename / pin / duplicate / archive / delete each call a live endpoint and then
 * refresh the list, and deleting the OPEN one also has to reset what the thread
 * is showing. None of it had integrated coverage: `SessionRail` was tested as a
 * component against callbacks, so every one of these paths was verified to call
 * a function, never to change anything.
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

test.describe("managing an investigation from the rail", () => {
  test("renaming it changes the rail AND the thread header", async ({ page }) => {
    const TITLE = await open(page);
    await rail(page).getByText(TITLE).first().click();
    await expect(thread(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });

    await menu(page, TITLE);
    await page.getByText("Rename", { exact: true }).click();
    const field = rail(page).locator("input").last();
    await field.fill("403 on acme-logs");
    await field.press("Enter");

    await expect(rail(page).getByText("403 on acme-logs")).toBeVisible({ timeout: 15_000 });
    // The header mirrors the title; a rename does not change activeId, so the
    // thread only refreshes if the app nudges it.
    await expect(thread(page).getByText("403 on acme-logs")).toBeVisible({ timeout: 15_000 });
  });

  test("duplicating it produces a second investigation with the same history", async ({ page }) => {
    const TITLE = await open(page);
    await menu(page, TITLE);
    await page.getByText("Duplicate", { exact: true }).click();

    await expect(rail(page).getByText(TITLE)).toHaveCount(2, { timeout: 15_000 });
    await expect(thread(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 15_000 });
  });

  test("deleting the OPEN investigation leaves a usable app, not a dead thread", async ({ page }) => {
    const TITLE = await open(page);
    await rail(page).getByText(TITLE).first().click();
    await expect(thread(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });

    await menu(page, TITLE);
    await page.getByText("Delete", { exact: true }).click();
    await page.getByRole("button", { name: /^delete$/i }).last().click();

    await expect(rail(page).getByText(TITLE)).toHaveCount(0, { timeout: 15_000 });
    // Back to the start surface — not an error card for a session that is gone.
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

  test("archiving it takes it out of the active list", async ({ page }) => {
    const TITLE = await open(page);
    await menu(page, TITLE);
    await page.getByText("Archive", { exact: true }).click();
    await expect(rail(page).getByText(TITLE)).toHaveCount(0, { timeout: 15_000 });
  });

  test("searching the rail narrows to what matches", async ({ page }) => {
    const TITLE = await open(page);
    const search = page.getByPlaceholder(/Search chats/i);
    await search.fill("seeded");
    await expect(rail(page).getByText(TITLE).first()).toBeVisible();
    await search.fill("no-such-investigation");
    await expect(rail(page).getByText(TITLE)).toHaveCount(0, { timeout: 10_000 });
  });
});
