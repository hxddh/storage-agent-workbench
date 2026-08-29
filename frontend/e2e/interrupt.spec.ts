import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";

/** Real Agent controls: Stop must cancel live execution, preserve partial work,
 * release the execution handle, and return the Composer to Delegate state. */
const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const task = (page: Page) => page.getByTestId("task-scroll");
const stopButton = (page: Page) => page.getByTestId("agent-composer").getByRole("button", { name: "Stop", exact: true });
const delegateButton = (page: Page) => page.getByTestId("agent-composer").getByRole("button", { name: "Delegate task", exact: true });

const LONG = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i} of a long answer about the bucket policy on acme-logs.`,
).join(" ");

async function open(page: Page, deltaDelayMs = 150) {
  const model = await startFakeModel([textTurn(LONG)], { deltaDelayMs });
  const providerId = await useFakeModel(model.baseUrl);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  return {
    model,
    cleanup: async () => {
      await dropModelProvider(providerId);
      await model.close();
    },
  };
}

async function ask(page: Page, direction: string) {
  await composer(page).fill(direction);
  await composer(page).press("Enter");
}

test.describe("interrupting Agent execution", () => {
  test("Stop replaces Delegate while Work Result is streaming", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(stopButton(page)).toBeVisible({ timeout: 30_000 });
      await expect(delegateButton(page)).toHaveCount(0);
    } finally { await cleanup(); }
  });

  test("pressing Stop ends execution and records that the user stopped it", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(task(page).getByText(/Paragraph 0 of a long answer/)).toBeVisible({ timeout: 30_000 });
      await stopButton(page).click();
      await expect(task(page).getByText(/Stopped by you/i).first()).toBeVisible({ timeout: 30_000 });
      await expect(delegateButton(page)).toBeVisible({ timeout: 30_000 });
    } finally { await cleanup(); }
  });

  test("partial work is kept, not thrown away", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "why does acme-logs return 403?");
      await expect(task(page).getByText(/Paragraph 0 of a long answer/)).toBeVisible({ timeout: 30_000 });
      await stopButton(page).click();
      await expect(task(page).getByText(/Stopped by you/i).first()).toBeVisible({ timeout: 30_000 });
      await expect(task(page).getByText(/Paragraph 0 of a long answer/)).toBeVisible();
      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => await task(page).evaluate((el) => el.textContent ?? ""), { timeout: 20_000 })
        .toContain("why does acme-logs return 403?");
    } finally { await cleanup(); }
  });

  test("a stopped execution does not block the next Direction", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await ask(page, "first question");
      await expect(task(page).getByText(/Paragraph 0 of a long answer/)).toBeVisible({ timeout: 30_000 });
      await stopButton(page).click();
      await expect(task(page).getByText(/Stopped by you/i).first()).toBeVisible({ timeout: 30_000 });
      await expect(delegateButton(page)).toBeVisible({ timeout: 30_000 });

      await ask(page, "second question");
      await expect
        .poll(async () => await task(page).evaluate((el) => el.textContent ?? ""), {
          timeout: 30_000,
          message: "the second Direction must enter the durable Agent task",
        })
        .toContain("second question");
      expect(await task(page).evaluate((el) => el.textContent ?? "")).toContain("first question");
    } finally { await cleanup(); }
  });
});
