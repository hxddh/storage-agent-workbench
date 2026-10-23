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
    toolTurn("query_estate", {}),
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

test("a message becomes a conversation: the work while live, the answer, Evidence beside it", async ({ page }) => {
  await boot(page);
  await delegate(page, "What evidence do I have attached?");
  await expect(page.getByTestId("task-page")).toBeVisible();
  await expect(page.getByTestId("answer")).toContainText("no attached files", { timeout: 30_000 });
  await settled(page);

  await expect(page.getByTestId("message")).toHaveText(/What evidence do I have attached\?/);
  await expect(page.getByTestId("task-page").getByRole("heading", { level: 1 })).toHaveText("What evidence do I have attached?");
  await expect(page.getByTestId("run-trace")).toContainText("1 check");
  const answer = page.getByTestId("answer");
  await expect(answer.locator("table")).toBeVisible();
  await expect(page.getByTestId("findings")).toContainText("No access log attached");
  await expect(page.getByText("Work log")).toHaveCount(0);

  // The agent names the task; the sidebar owns the identity.
  await expect(page.getByTestId("task-title")).toHaveCount(0);
  await expect(page.getByTestId("task-list")).toContainText("Attached evidence check", { timeout: 15_000 });
  await page.getByTestId("hide-sidebar").click();
  await expect(page.getByTestId("task-title")).toHaveText("Attached evidence check");
  await page.getByTestId("show-sidebar").click();

  // No follow-up card or next-step prompt is painted.
  await expect(page.getByTestId("next-step")).toHaveCount(0);
  await expect(page.getByTestId("suggestions")).toHaveCount(0);

  // Evidence is one pane; a call expands in place.
  await page.getByTestId("titlebar-sidepane").click();
  const inspector = page.getByTestId("inspector");
  await expect(inspector).toContainText("Save report");
  await inspector.getByTestId("evidence-call").first().click();
  await expect(inspector.getByTestId("call-detail").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector")).toHaveCount(0);
});

test("⌘K finds the task again", async ({ page }) => {
  await boot(page);
  await delegate(page, "What evidence do I have attached?");
  await settled(page);
  await page.getByTestId("new-task").click();
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("task-search")).toBeFocused();
  await page.keyboard.type("evidence");
  await page.getByTestId("task-list").getByRole("button", { name: /evidence/i }).first().click();
  await expect(page.getByTestId("answer")).toBeVisible();
});
