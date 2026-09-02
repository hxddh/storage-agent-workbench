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

test.describe("Worked groups in the Agent turn", () => {
  test("the newest turn shows the tools the Agent ran behind a folded worked group", async ({ page }) => {
    await open(page);
    const group = page.getByTestId("worked-group").last();
    await expect(group).toBeVisible();
    await expect(group).toContainText(/Worked/);
    await group.getByTestId("execution-head").click();
    await expect(task(page).getByText("head_bucket").last()).toBeVisible();
    await expect(page.getByTestId("execution-summary")).toHaveCount(0);
  });

  test("an execution step opens the real persisted call input and output", async ({ page }) => {
    await open(page);
    await page.getByTestId("worked-group").last().getByTestId("execution-head").click();
    await page.getByTestId("trace-row-open").last().click();
    await expect(task(page).getByText(/"status"\s*:\s*200/).first()).toBeVisible({ timeout: 15_000 });
  });

  test("Artifacts open as a split beside the task without replacing it", async ({ page }) => {
    await open(page);
    await page.keyboard.press("Control+i");

    await expect(page.getByTestId("agent-shell")).toHaveAttribute("data-artifacts", "open");
    const panel = page.getByTestId("agent-artifacts-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-mode", "split");
    await expect(page.getByTestId("artifacts-section-evidence")).toBeVisible();
    await expect(page.getByTestId("artifacts-section-execution")).toBeVisible();
    await expect(page.getByTestId("agent-composer")).toBeVisible();
    await expect(page.getByTestId("agent-artifacts-scrim")).toHaveCount(0);
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
  const group = page.getByTestId("worked-group").last();
  await expect(group).toBeVisible({ timeout: 20_000 });
  await group.getByTestId("execution-head").click();
  const row = page.getByTestId("trace-row-open").last();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByText(/RETURNED|SENT/i).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);
  await expect(row).toBeInViewport();
});
