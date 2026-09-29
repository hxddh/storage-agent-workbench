import { expect, test } from "@playwright/test";
import { boot, reset } from "./app";

test.beforeEach(reset);

test("a fresh install says what is missing and starts nothing on its own", async ({ page }) => {
  await boot(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What should we look after today?");
  const ready = page.getByTestId("readiness");
  await expect(ready).toHaveText("Add a model and add a storage account to get started.");
  await expect(page.getByTestId("model-chip")).toHaveText("Set up a model…");
  // A starter only fills the Composer.
  await page.getByRole("button", { name: "Diagnose an access error" }).click();
  await expect(page.getByTestId("composer-input")).toHaveValue(/I get an error when accessing my bucket/);
  await expect(page.getByTestId("task-list")).toContainText("No tasks yet");
  // The survey starter needs a storage account: without one it is not offered.
  await expect(page.getByRole("button", { name: /Survey my storage account/ })).toHaveCount(0);
  // The readiness sentence opens the right Settings pane.
  await ready.getByRole("button", { name: /Add a model/ }).click();
  await expect(page.getByTestId("settings")).toBeVisible();
  await expect(page.getByTestId("model-editor")).toBeVisible();
});

test("without a model the task says why it could not start and where to fix it", async ({ page }) => {
  await boot(page);
  await page.getByTestId("composer-input").fill("Why is my bucket slow?");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("attention")).toContainText("No model is configured");
  await page.getByTestId("attention").getByRole("button", { name: "Open Settings" }).click();
  await expect(page.getByTestId("settings")).toBeVisible();
});
