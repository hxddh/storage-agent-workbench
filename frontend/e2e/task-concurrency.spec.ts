import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";

/** A modern Agent is task-oriented, not viewport-oriented. Switching away from
 * active work must not cancel it; navigation must keep showing the task as
 * Working, and reopening it must reconnect to the same live/durable execution. */
const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const navigation = (page: Page) => page.getByTestId("agent-task-navigation");

const LONG_RESULT = Array.from(
  { length: 32 },
  (_, index) => `Execution segment ${index}: inspecting acme-logs policy and lifecycle state.`,
).join(" ");

async function setup(page: Page) {
  const model = await startFakeModel([textTurn(LONG_RESULT)], { deltaDelayMs: 140 });
  const providerId = await useFakeModel(model.baseUrl);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  return async () => {
    await dropModelProvider(providerId);
    await model.close();
  };
}

test("an Agent task keeps executing while the user works in another task", async ({ page }) => {
  const cleanup = await setup(page);
  try {
    await composer(page).fill("Inspect acme-logs deeply and report the policy and lifecycle state.");
    await composer(page).press("Enter");
    await expect(page.getByTestId("agent-live-status")).toBeVisible({ timeout: 20_000 });

    const workingRow = navigation(page).locator('[data-testid="task-row"][data-state="working"]').first();
    await expect(workingRow).toBeVisible({ timeout: 20_000 });
    const taskTitle = ((await workingRow.locator("strong").first().textContent()) ?? "").trim();
    expect(taskTitle.length).toBeGreaterThan(0);

    await navigation(page).getByRole("button", { name: /^New task/i }).click();
    await expect(composer(page)).toHaveValue("");
    await expect(page.getByTestId("agent-task-header")).toContainText("Ready to delegate");

    // Execution belongs to Task A, not to the viewport that happened to show it.
    const backgroundRow = navigation(page).getByTestId("task-row").filter({ hasText: taskTitle }).first();
    await expect(backgroundRow).toHaveAttribute("data-state", "working", { timeout: 20_000 });

    await backgroundRow.click();
    await expect(page.getByTestId("agent-task-header")).toContainText(/Agent working|Ready for direction/, { timeout: 20_000 });
    await expect
      .poll(async () => await page.getByTestId("task-scroll").textContent(), {
        timeout: 60_000,
        message: "reopening the task must reconnect to its continuing Execution and durable Work Result",
      })
      .toContain("Execution segment 0");

    await expect(page.getByTestId("work-result").last()).toContainText("Execution segment 31", { timeout: 60_000 });
    await expect(backgroundRow).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  } finally {
    await cleanup();
  }
});
