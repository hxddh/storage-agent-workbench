import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

const rail = (page: Page) => page.getByTestId("session-rail");
const task = (page: Page) => page.locator("main");

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

async function row(page: Page, title: string) {
  return rail(page).getByTestId("task-row").filter({ hasText: title }).first();
}

async function menu(page: Page, title: string) {
  const taskRow = await row(page, title);
  await taskRow.hover();
  await taskRow.getByRole("button", { name: /more/i }).click();
}

test.describe("Agent task navigation", () => {
  test("rows expose live Agent task state and scope rather than internal case counters", async ({ page }) => {
    const TITLE = await open(page);
    await expect(rail(page)).toHaveAttribute("data-navigation", "agent-tasks");
    const taskRow = await row(page, TITLE);
    await expect(taskRow).toContainText("Ready");
    await expect(taskRow).toContainText("General storage task");
    await expect(taskRow).not.toContainText("0F");
    await expect(taskRow).not.toContainText("0R");
  });

  test("renaming a task changes navigation and active Agent task identity", async ({ page }) => {
    const TITLE = await open(page);
    await (await row(page, TITLE)).click();
    await expect(task(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });

    await menu(page, TITLE);
    await page.getByText("Rename", { exact: true }).click();
    const field = rail(page).getByTestId("task-row-rename").locator("input");
    await field.fill("403 on acme-logs");
    await field.press("Enter");

    await expect(rail(page).getByText("403 on acme-logs")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("workbench-commandbar")).toContainText("403 on acme-logs", { timeout: 15_000 });
  });

  test("duplicating a task produces a second task with the same durable history", async ({ page }) => {
    const TITLE = await open(page);
    await menu(page, TITLE);
    await page.getByText("Duplicate", { exact: true }).click();

    await expect(rail(page).getByText(TITLE)).toHaveCount(2, { timeout: 15_000 });
    await expect(task(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 15_000 });
  });

  test("deleting the open task returns to a usable delegation surface", async ({ page }) => {
    const TITLE = await open(page);
    await (await row(page, TITLE)).click();
    await expect(task(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });

    await menu(page, TITLE);
    await page.getByText("Delete", { exact: true }).click();
    await page.getByRole("button", { name: /^delete$/i }).last().click();

    await expect(rail(page).getByText(TITLE)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("agent-composer")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("workbench-commandbar")).toContainText("Ready to delegate");
    await expect(task(page).getByText(/Couldn't load/i)).toHaveCount(0);
  });

  test("deleting a task does not resurrect it on the next launch", async ({ page }) => {
    const TITLE = await open(page);
    await (await row(page, TITLE)).click();
    await expect(task(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });

    await menu(page, TITLE);
    await page.getByText("Delete", { exact: true }).click();
    await page.getByRole("button", { name: /^delete$/i }).last().click();
    await expect(rail(page).getByText(TITLE)).toHaveCount(0, { timeout: 15_000 });

    await page.reload();
    await expect(page.getByTestId("agent-composer")).toBeVisible({ timeout: 20_000 });
    await expect(rail(page).getByText(TITLE)).toHaveCount(0);
  });

  test("archiving removes a task from the active task list", async ({ page }) => {
    const TITLE = await open(page);
    await menu(page, TITLE);
    await page.getByText("Archive", { exact: true }).click();
    await expect(rail(page).getByText(TITLE)).toHaveCount(0, { timeout: 15_000 });
  });

  test("server-backed search narrows tasks by title or message content", async ({ page }) => {
    const TITLE = await open(page);
    const search = page.getByPlaceholder(/Search tasks/i);
    await search.fill("seeded");
    await expect(rail(page).getByText(TITLE).first()).toBeVisible();
    await search.fill("no-such-task");
    await expect(rail(page).getByText(TITLE)).toHaveCount(0, { timeout: 10_000 });
  });
});
