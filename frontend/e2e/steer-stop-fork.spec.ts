import { expect, test } from "@playwright/test";
import { boot, delegate, reset, settled } from "./app";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel, type FakeModel } from "./fake-model";

let model: FakeModel | null = null;
let providerId = "";

test.beforeEach(reset);
test.afterEach(async () => {
  if (providerId) await dropModelProvider(providerId);
  await model?.close();
});

test("while it works the Composer steers, and Stop keeps the partial work", async ({ page }) => {
  model = await startFakeModel([toolTurn("list_uploaded_files", {}), textTurn("word ".repeat(300))], { deltaDelayMs: 40 });
  providerId = await useFakeModel(model.baseUrl);
  await boot(page);
  await delegate(page, "Take your time");
  await expect(page.getByTestId("task-state")).toHaveText("Working");
  await expect(page.getByTestId("composer-send")).toHaveText("Steer");
  await delegate(page, "Focus on the logs bucket");
  await expect(page.getByTestId("work-in-progress")).toContainText("Focus on the logs bucket");
  await page.getByTestId("composer-stop").click();
  await settled(page);
  await expect(page.getByTestId("document")).toContainText("Stopped");
});

test("editing a Direction sends a new version; the old one stays one click away", async ({ page }) => {
  model = await startFakeModel([textTurn("First answer."), textTurn("Second answer."), textTurn("Reworded answer.")]);
  providerId = await useFakeModel(model.baseUrl);
  await boot(page);
  await delegate(page, "Question one");
  await settled(page);
  await delegate(page, "Question two");
  await expect(page.getByTestId("result")).toContainText("Second answer.", { timeout: 30_000 });
  await settled(page);

  const second = page.locator(".direction", { hasText: "Question two" });
  await second.hover();
  await second.getByTestId("edit-direction").click();
  await expect(page.getByTestId("composer")).toContainText("Editing");
  await page.getByTestId("composer-input").fill("Question two, reworded");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("result")).toContainText("Reworded answer.", { timeout: 30_000 });
  await settled(page);
  await expect(page.getByText("2 of 2")).toBeVisible();
  await expect(page.getByTestId("document")).not.toContainText("Second answer.");

  await page.getByRole("button", { name: "Previous version" }).click();
  await expect(page.getByTestId("result")).toContainText("Second answer.");
  await expect(page.getByText("1 of 2")).toBeVisible();
});
