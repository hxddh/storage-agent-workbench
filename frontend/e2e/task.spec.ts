import { expect, test } from "@playwright/test";
import { boot, delegate, reset, settled } from "./app";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, type FakeModel } from "./fake-model";

let model: FakeModel;
let providerId: string;

const conclusion = {
  answer: "No files are attached yet, so there is nothing to analyze.",
  findings: [
    { title: "No access log attached", severity: "medium", detail: "Attach one to measure error rates." },
    { title: "The task has no evidence yet", severity: "info", detail: "" },
  ],
  next_steps: ["Attach last week's access log", "Survey the account instead"],
};

test.beforeEach(async () => {
  await reset();
  model = await startFakeModel([
    toolTurn("list_uploaded_files", {}),
    toolTurn("record_conclusion", conclusion),
    textTurn("There are **no attached files** yet.\n\n| Kind | Count |\n|---|---|\n| Access logs | 0 |\n| Inventories | 0 |"),
  ], { title: "Attached evidence check" });
  const { useFakeModel } = await import("./fake-model");
  providerId = await useFakeModel(model.baseUrl);
});

test.afterEach(async () => {
  await dropModelProvider(providerId);
  await model.close();
});

test("a Direction becomes a result-first task with its outputs in the side pane", async ({ page }) => {
  await boot(page);
  await delegate(page, "What evidence do I have attached?");
  await expect(page.getByTestId("task-page")).toBeVisible();
  await expect(page.getByTestId("result-answer")).toHaveText(conclusion.answer, { timeout: 30_000 });
  await settled(page);

  // Conclusion first: findings with severity badges, next steps, then the full answer.
  const result = page.getByTestId("result");
  await expect(result).toContainText("No access log attached");
  await expect(result).toContainText("Medium");
  await expect(result.locator("table")).toBeVisible();
  // One Direction: no Work log; its work sits above the outputs.
  await expect(page.getByText("Work log")).toHaveCount(0);
  await expect(result.getByText(/Worked for/)).toBeVisible();

  // The agent names the task; the sidebar and title bar follow.
  await expect(page.getByTestId("task-title")).toHaveText("Attached evidence check", { timeout: 15_000 });
  await expect(page.getByTestId("task-list")).toContainText("Attached evidence check");

  // A next step fills the Composer and sends nothing.
  await result.getByRole("button", { name: /Attach last week's access log/ }).click();
  await expect(page.getByTestId("composer-input")).toHaveValue("Attach last week's access log");

  // Outputs open the side pane.
  await page.getByTestId("outputs").getByRole("button", { name: /Evidence/ }).click();
  await expect(page.getByTestId("evidence")).toContainText("No access log attached");
  await page.getByRole("tab", { name: /Report/ }).click();
  await expect(page.getByTestId("report")).toContainText("Conclusion");
  await expect(page.getByTestId("report")).toContainText("Safety");
  await page.getByRole("tab", { name: /Activity/ }).click();
  await page.getByTestId("activity").getByRole("button", { name: /Listed attached files/ }).click();
  await expect(page.getByTestId("call-detail")).toContainText("list_uploaded_files");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector")).toHaveCount(0);
});

test("⌘K finds the task again", async ({ page }) => {
  await boot(page);
  await delegate(page, "What evidence do I have attached?");
  await settled(page);
  await page.getByTestId("nav-home").click();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("evidence");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("result-answer")).toBeVisible();
});
