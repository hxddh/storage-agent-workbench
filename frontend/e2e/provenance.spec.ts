import { expect, test } from "@playwright/test";
import { seedOptimizationTask } from "./seed";

test("clicking a finding opens Review Evidence anchored to that finding", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  const { title, id } = seedOptimizationTask("Provenance chain", "review");
  const findingId = `fnd-${id.slice(-8)}`;
  await page.goto("/");
  await page.getByTestId("agent-task-navigation").getByText(title, { exact: true }).first().click();
  await expect(page.getByTestId("analysis-figures").first()).toBeVisible({ timeout: 20_000 });
  const mark = page.getByTestId(`finding-provenance-${findingId}`).first();
  await expect(mark).toBeVisible();
  await mark.hover();
  await expect(page.getByTestId("provenance-preview").first()).toBeVisible();
  await mark.click();
  await expect(page.getByTestId("agent-review-panel")).toBeVisible();
  await expect(page.getByTestId("evidence-review")).toBeVisible();
  const row = page.locator(`#finding-${findingId}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-selected", "true");
});
