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

test("while it works the Composer adds to the request, and Stop keeps the partial work", async ({ page }) => {
  model = await startFakeModel([toolTurn("list_uploaded_files", {}), textTurn("word ".repeat(300))], { deltaDelayMs: 40 });
  providerId = await useFakeModel(model.baseUrl);
  await boot(page);
  await delegate(page, "Take your time");
  await expect(page.getByTestId("task-state")).toHaveText("Working");
  await expect(page.getByTestId("composer-send")).toHaveAccessibleName("Add to the request");
  await delegate(page, "Focus on the logs bucket");
  await page.getByTestId("activity-line").click();
  await expect(page.getByTestId("turn").last()).toContainText("Focus on the logs bucket");
  await page.getByTestId("composer-stop").click();
  await settled(page);
  await expect(page.getByTestId("document")).toContainText("Stopped");
});

test("follow-ups read top to bottom, each under its own message, and survive a reload", async ({ page }) => {
  model = await startFakeModel([
    textTurn("First answer."), toolTurn("list_uploaded_files", {}), textTurn("Second answer."),
    textTurn("Third answer."), textTurn("Fourth answer."),
  ], { deltaDelayMs: 10 });
  providerId = await useFakeModel(model.baseUrl);
  await boot(page);
  for (const [q, a] of [["Question one", "First answer."], ["Question two", "Second answer."],
    ["Question three", "Third answer."], ["Question four", "Fourth answer."]]) {
    await delegate(page, q);
    await expect(page.getByTestId("turn").last()).toContainText(a, { timeout: 30_000 });
    await settled(page);
  }
  const check = async () => {
    const turns = page.getByTestId("turn");
    await expect(turns).toHaveCount(4);
    for (const [i, a] of ["First answer.", "Second answer.", "Third answer.", "Fourth answer."].entries()) {
      await expect(turns.nth(i)).toContainText(a);
      await expect(turns.nth(i).getByTestId("answer")).toHaveCount(1);
    }
    const text = (await page.getByTestId("task-page").textContent()) ?? "";
    expect(text.split("Second answer.").length - 1).toBe(1); // nothing doubled
  };
  await check();
  await page.reload();
  await expect(page.getByTestId("turn")).toHaveCount(4);
  await check();
});

test("editing a message sends a new version; the old one stays one click away", async ({ page }) => {
  model = await startFakeModel([textTurn("First answer."), textTurn("Second answer."), textTurn("Reworded answer.")]);
  providerId = await useFakeModel(model.baseUrl);
  await boot(page);
  await delegate(page, "Question one");
  await settled(page);
  await delegate(page, "Question two");
  await expect(page.getByTestId("turn").last()).toContainText("Second answer.", { timeout: 30_000 });
  await settled(page);

  const second = page.getByTestId("message").filter({ hasText: "Question two" });
  await second.hover();
  await second.getByTestId("edit-message").click();
  await expect(page.getByTestId("composer")).toContainText("Editing");
  await page.getByTestId("composer-input").fill("Question two, reworded");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("turn").last()).toContainText("Reworded answer.", { timeout: 30_000 });
  await settled(page);
  await expect(page.getByText("2 / 2")).toBeVisible();
  await expect(page.getByTestId("document")).not.toContainText("Second answer.");

  await page.getByRole("button", { name: "Previous version" }).click();
  await expect(page.getByTestId("turn").last()).toContainText("Second answer.");
  await expect(page.getByText("1 / 2")).toBeVisible();
});
