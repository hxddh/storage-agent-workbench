import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const openReview = (page: Page) => page.getByTestId("agent-task-review");
const SKILL = "storageops-security-iam-policy";
const FOLLOW_UP = "Summarize the evidence again while I keep the review open.";
const FOLLOW_UP_ANSWER = "The evidence still supports the same IAM-policy conclusion after review.";

async function setup(page: Page, opts: { deltaDelayMs?: number } = {}) {
  const model = await startFakeModel([
    toolTurn("read_skill", { name: SKILL }),
    textTurn("The task is ready for review. The persisted skill evidence is available below."),
    textTurn(FOLLOW_UP_ANSWER),
  ], opts);
  const providerId = await useFakeModel(model.baseUrl);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
    localStorage.setItem("saw.activityDensity", "balanced");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  return {
    model,
    cleanup: async () => {
      await dropModelProvider(providerId);
      await model.close();
    },
  };
}

async function completeTurn(page: Page) {
  await composer(page).fill("Review the IAM-policy diagnostic method and keep the evidence available for inspection.");
  await composer(page).press("Enter");
  await expect(page.getByTestId("execution-summary-toggle")).toBeVisible({ timeout: 20_000 });
}

test.describe("Agent-native task shell", () => {
  test("Review is contextual output and never replaces the active Agent task", async ({ page }) => {
    const { cleanup } = await setup(page);
    try {
      await completeTurn(page);
      const task = page.getByTestId("task-scroll");
      await expect(task).toBeVisible();

      await openReview(page).click();
      const review = page.getByTestId("agent-review-panel");
      await expect(review).toBeVisible();
      await expect(task).toBeVisible();
      await expect(page.getByRole("tab")).toHaveCount(0);

      await review.getByRole("button", { name: "Evidence", exact: true }).click();
      await expect(page.getByTestId("evidence-review")).toBeVisible();
      await expect(task).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test("Focus mode removes global navigation while preserving task and Review", async ({ page }) => {
    const { cleanup } = await setup(page);
    try {
      await completeTurn(page);
      await openReview(page).click();
      const review = page.getByTestId("agent-review-panel");
      await review.getByRole("button", { name: "Evidence", exact: true }).click();

      await page.getByRole("button", { name: "Focus task" }).click();
      await expect(page.getByTestId("agent-shell")).toHaveAttribute("data-focus", "true");
      await expect(page.getByTestId("agent-task-navigation")).not.toBeVisible();
      await expect(page.getByTestId("task-scroll")).toBeVisible();
      await expect(page.getByTestId("evidence-review")).toBeVisible();

      await page.getByRole("button", { name: "Exit focus mode" }).click();
      await expect(page.getByTestId("agent-task-navigation")).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test("resting task control reads as delegation, not a model playground", async ({ page }) => {
    const { cleanup } = await setup(page);
    try {
      await completeTurn(page);
      const control = page.getByTestId("agent-composer");
      await expect(control).toHaveAttribute("data-agent-state", "ready");
      await expect(control.getByRole("button", { name: "Delegate task", exact: true })).toBeVisible();
      await expect(control.getByText("fake-model", { exact: true })).toHaveCount(0);
      await expect(page.getByTestId("work-result").first()).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test("Review stays open while the same task Composer continues the Agent task", async ({ page }) => {
    const { cleanup, model } = await setup(page);
    try {
      await completeTurn(page);
      const baselineRequests = model.requests.length;
      await openReview(page).click();
      const review = page.getByTestId("agent-review-panel");
      await expect(review).toBeVisible();

      await composer(page).fill(FOLLOW_UP);
      await composer(page).press("Enter");
      await expect.poll(() => model.requests.length, {
        timeout: 10_000,
        message: "the task Composer must continue through the configured model while Review stays open",
      }).toBeGreaterThan(baselineRequests);

      await expect(page.getByTestId("task-scroll").getByText(FOLLOW_UP, { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("task-scroll").getByText(FOLLOW_UP_ANSWER, { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(review).toBeVisible();

      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("task-scroll").getByText(FOLLOW_UP, { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("task-scroll").getByText(FOLLOW_UP_ANSWER, { exact: true })).toBeVisible({ timeout: 20_000 });
    } finally {
      await cleanup();
    }
  });

  test("a running task exposes real Agent execution and steering state", async ({ page }) => {
    const { cleanup } = await setup(page, { deltaDelayMs: 160 });
    try {
      await composer(page).fill("Inspect the IAM diagnostic method and explain what you are checking.");
      await composer(page).press("Enter");

      const live = page.getByTestId("agent-live-status");
      await expect(live).toBeVisible({ timeout: 10_000 });
      await expect(live).toContainText("Agent working");
      const control = page.getByTestId("agent-composer");
      await expect(control).toHaveAttribute("data-agent-state", "working");
      await expect(control.getByRole("button", { name: "Steer Agent", exact: true })).toBeVisible();
      await expect(control.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await expect(page.getByTestId("agent-task-header")).toContainText("Agent working");
    } finally {
      await cleanup();
    }
  });

  test("Report opens as an Artifact review beside the durable task", async ({ page }) => {
    const { cleanup } = await setup(page);
    try {
      await completeTurn(page);
      await composer(page).fill("/report");
      await composer(page).press("Enter");

      const review = page.getByTestId("agent-review-panel");
      await expect(review).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("report-artifact")).toBeVisible();
      await expect(page.getByTestId("task-scroll")).toBeVisible();
      await expect(page.getByRole("tab")).toHaveCount(0);
      await expect(page.locator(".fixed.inset-0.z-floating")).toHaveCount(0);
      await expect(page.getByTestId("report-copy")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("report-save")).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
