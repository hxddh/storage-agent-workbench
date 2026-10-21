import { expect, test } from "@playwright/test";
import { boot, reset } from "./app";

test.beforeEach(reset);

test("a fresh install is one canvas and one Composer, and starts nothing on its own", async ({ page }) => {
  await boot(page);
  await expect(page.getByTestId("home").getByRole("heading", { level: 1 })).toHaveText("Ask about your storage.");
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("readiness")).toHaveCount(0);
  await expect(page.getByTestId("needs-care")).toHaveCount(0);
  await expect(page.getByTestId("model-chip")).toHaveText("Set up a model…");
  await expect(page.getByTestId("task-list")).toContainText("No tasks yet");
  await page.getByTestId("model-chip").click();
  await expect(page.getByTestId("settings")).toBeVisible();
  await expect(page.getByTestId("model-editor")).toBeVisible();
});

test("without a model nothing is sent; the chip says where to set one up", async ({ page }) => {
  await boot(page);
  await page.getByTestId("composer-input").fill("Why is my bucket slow?");
  await expect(page.getByTestId("composer-send")).toBeDisabled();
  await page.getByTestId("model-chip").click();
  await expect(page.getByTestId("settings")).toBeVisible();
  await expect(page.getByTestId("model-editor")).toBeVisible();
});
