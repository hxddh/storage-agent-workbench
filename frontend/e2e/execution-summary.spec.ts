import { expect, test, type Page } from "@playwright/test";
import { seedSession } from "./seed";

const task = (page: Page) => page.locator("main");

async function open(page: Page, exchanges = 3) {
  const { title } = seedSession(exchanges);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await page.getByText(title).first().click();
  await expect(task(page).getByText(/ANSWER-/).first()).toBeVisible({ timeout: 20_000 });
}

test.describe("Execution Summary", () => {
  test("reports measured execution cost without inventing missing data", async ({ page }) => {
    await open(page);
    const summary = page.getByTestId("execution-summary").last();
    await expect(summary).toContainText("1.2k");
    await expect(summary).toContainText("300");
    await expect(summary).toContainText(/2\.4\s*s/);
  });

  test("the newest Work Result exposes what the Agent ran by default", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("execution-step-open").last()).toBeVisible();
    await expect(task(page).getByText("head_bucket").last()).toBeVisible();

    await page.getByTestId("execution-summary-toggle").last().click();
    await expect(page.getByTestId("execution-step-open")).toHaveCount(0);
    await expect(page.getByTestId("execution-latest-step").last()).toContainText("head_bucket");
  });

  test("historical execution stays folded instead of turning task history into a trace wall", async ({ page }) => {
    await open(page);
    const summaries = await page.getByTestId("execution-summary-toggle").count();
    const openSteps = await page.getByTestId("execution-step-open").count();
    expect(summaries).toBeGreaterThan(1);
    expect(openSteps).toBeLessThanOrEqual(2);
  });

  test("an execution step opens the real persisted call input and output", async ({ page }) => {
    await open(page);
    await page.getByTestId("execution-step-open").last().click();
    await expect(task(page).getByText(/"status"\s*:\s*200/).first()).toBeVisible({ timeout: 15_000 });
  });

  test("Review evidence opens contextual task Review without replacing the task", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: /review evidence/i }).last().click();

    await expect(page.getByTestId("agent-shell")).toHaveAttribute("data-review", "evidence");
    await expect(page.getByTestId("agent-review-panel")).toBeVisible();
    const evidence = page.getByTestId("evidence-review");
    await expect(evidence).toBeVisible();
    await expect(evidence.getByText(/head_bucket/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("agent-composer")).toBeVisible();
  });
});

test("opening a persisted execution step keeps its detail in view", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { title } = seedSession(4, `open-execution ${Date.now()}`, "tall");
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await page.getByText(title, { exact: true }).first().click();
  const row = page.getByTestId("execution-step-open").last();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByText(/RETURNED|SENT/i).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);
  await expect(row).toBeInViewport();
});
