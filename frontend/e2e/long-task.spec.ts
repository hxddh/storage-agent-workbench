import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

/**
 * Long-running Agent tasks must remain navigable on the real stack.
 *
 * The persistence API returns a bounded tail plus a total count, so sufficiently
 * long task histories are paged. These tests protect the user-facing contract:
 * older Direction / Work Result history can be loaded, find reaches historical
 * work, branching preserves the source task, drafts survive task switches, and
 * keyboard navigation works without stealing keystrokes from the Agent input.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const task = (page: Page) => page.getByRole("main", { name: /Agent task/i });
const taskScroll = (page: Page) => page.getByTestId("task-scroll");
const navigation = (page: Page) => page.getByTestId("agent-task-navigation");

/** 40 Direction / Work Result cycles = 80 persisted entries, past one page. */
const TASK_CYCLES = 40;

async function openLongTask(page: Page): Promise<string> {
  const { title } = seedSession(TASK_CYCLES);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await page.getByText(title, { exact: true }).first().click();
  await expect(task(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });
  return title;
}

const taskText = (page: Page) =>
  task(page).evaluate((element) => (element.textContent ?? "").replace(/\s+/g, " "));

test.describe("a paged Agent task", () => {
  test("offers to load durable history that is not currently rendered", async ({ page }) => {
    await openLongTask(page);
    await expect(page.getByTestId("load-earlier")).toBeVisible();
    await expect(page.getByTestId("load-earlier")).toContainText("20");
  });

  test("opens on the newest work rather than the oldest", async ({ page }) => {
    await openLongTask(page);
    const text = await taskText(page);
    expect(text, "the current task tail must be present").toContain(`QUESTION-${TASK_CYCLES - 1}`);
    expect(text, "the oldest Direction must initially remain paged out").not.toContain("QUESTION-00 ");
  });

  test("loading earlier history prepends it without losing current work", async ({ page }) => {
    await openLongTask(page);
    await page.getByTestId("load-earlier").click();
    await expect(page.getByTestId("load-earlier")).toBeHidden({ timeout: 15_000 });
    const text = await taskText(page);
    expect(text, "the oldest Direction must arrive").toContain("QUESTION-00 ");
    expect(text, "the newest Direction must remain present").toContain(`QUESTION-${TASK_CYCLES - 1}`);
  });

  test("jump to task start reaches the first Direction", async ({ page }) => {
    await openLongTask(page);
    await page.getByTestId("jump-to-start").click();
    await expect(page.getByTestId("jump-to-start")).toBeHidden({ timeout: 20_000 });
    expect(await taskText(page)).toContain("QUESTION-00 ");
  });

  test("all persisted cycles are present once history is fully loaded", async ({ page }) => {
    await openLongTask(page);
    await page.getByTestId("jump-to-start").click();
    await expect(page.getByTestId("jump-to-start")).toBeHidden({ timeout: 20_000 });
    const text = await taskText(page);
    for (let index = 0; index < TASK_CYCLES; index++) {
      expect(text, `task cycle ${index} must be present`).toContain(
        `QUESTION-${String(index).padStart(2, "0")} `,
      );
    }
  });
});

test.describe("finding historical work", () => {
  test("find reaches a result outside the initially rendered history", async ({ page }) => {
    await openLongTask(page);
    await page.keyboard.press("ControlOrMeta+f");
    const input = page.getByTestId("find-input");
    await expect(input).toBeVisible();
    await input.fill("bucket-25 denies");
    await expect(task(page).getByText(/ANSWER-25/)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("branching an Agent task from a Direction", () => {
  test("creates a second task and leaves the source task intact", async ({ page }) => {
    await openLongTask(page);
    const before = (await navigation(page).textContent()) ?? "";

    const direction = task(page).getByText(`QUESTION-${TASK_CYCLES - 1} `).last();
    await direction.scrollIntoViewIfNeeded();
    await direction.hover();
    await page.getByTestId("branch-message").last().click();

    await expect
      .poll(async () => ((await navigation(page).textContent()) ?? "").length, { timeout: 15_000 })
      .toBeGreaterThan(before.length);
    await expect(task(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("the Agent input on a loaded task", () => {
  test("a draft Direction survives switching away and back", async ({ page }) => {
    const title = await openLongTask(page);
    await composer(page).fill("does bucket-7 have a lifecycle rule");
    await page.getByRole("button", { name: /^New task$/i }).first().click();
    await expect(composer(page)).toHaveValue("", { timeout: 10_000 });
    await page.getByText(title, { exact: true }).first().click();
    await expect(composer(page)).toHaveValue("does bucket-7 have a lifecycle rule", {
      timeout: 10_000,
    });
  });
});

test.describe("finding a term that appears many times in one Work Result", () => {
  test("steps through individual matches and paints the active one", async ({ page }) => {
    test.setTimeout(90_000);
    const { title } = seedSession(6, `find ${Date.now()}`, "tall");
    await page.addInitScript(() => {
      localStorage.setItem("saw.lang", "en");
      localStorage.setItem("saw.onboarded", "1");
    });
    await page.goto("/");
    await page.getByText(title, { exact: true }).first().click();
    await expect(page.locator(".task-item").first()).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.getByTestId("find-input")).toBeVisible();
    await page.getByTestId("find-input").fill("bucket-003");
    await page.waitForTimeout(900);

    const paint = await page.evaluate(() => {
      const registry = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights;
      return {
        supported: !!registry,
        rest: registry?.get("saw-find")?.size ?? 0,
        active: registry?.get("saw-find-active")?.size ?? 0,
      };
    });
    expect(paint.supported).toBe(true);
    expect(paint.active).toBe(1);
    expect(paint.rest).toBeGreaterThan(1);

    const position = () => taskScroll(page).evaluate((element) => Math.round(element.scrollTop));
    const before = await position();
    for (let index = 0; index < 4; index++) {
      await page.getByTestId("find-next").click();
      await page.waitForTimeout(350);
    }
    expect(Math.abs((await position()) - before)).toBeGreaterThan(20);
  });
});

test.describe("keyboard navigation through task history", () => {
  test("j and k move between task steps but remain ordinary text in the Agent input", async ({ page }) => {
    await openLongTask(page);
    const position = () => taskScroll(page).evaluate((element) => Math.round(element.scrollTop));

    const start = await position();
    await page.locator("body").press("k");
    await page.waitForTimeout(700);
    const up = await position();
    expect(up, "k moves back through task history").toBeLessThan(start);

    await page.locator("body").press("j");
    await page.waitForTimeout(700);
    expect(await position(), "j moves forward through task history").toBeGreaterThan(up);

    const input = composer(page);
    await input.click();
    const beforeTyping = await position();
    await input.type("jkjk");
    await page.waitForTimeout(500);
    await expect(input).toHaveValue("jkjk");
    expect(await position(), "typing must not navigate task history").toBe(beforeTyping);
  });
});
