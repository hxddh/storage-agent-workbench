import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";
import { waitForDurableAnswer } from "./work-result";

/**
 * v1.12 — the plan the model owns.
 *
 * `update_plan` is a real runtime tool: each call replaces the list, the
 * runtime records `plan.updated`, and the transcript paints ONE checklist
 * card at the position of the first call, updated in place. Once every step
 * is completed and the turn has settled the card folds to "Plan · 2/2". The
 * UI never invents a step: a turn without the tool has no card.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");

const ANSWER = "Two buckets surveyed; the acme-logs policy allows public reads.";

const PLAN_OPEN = [
  { text: "Survey the account", status: "in_progress" },
  { text: "Check policies", status: "pending" },
];
const PLAN_DONE = [
  { text: "Survey the account", status: "completed" },
  { text: "Check policies", status: "completed" },
];

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
}

test.describe("the plan checklist", () => {
  test.describe.configure({ timeout: 120_000 });

  test("a turn that calls update_plan paints one checklist that folds once every step is done", async ({ page }) => {
    const model = await startFakeModel(
      [
        toolTurn("update_plan", { steps: PLAN_OPEN }),
        toolTurn("update_plan", { steps: PLAN_DONE }),
        textTurn(ANSWER),
      ],
      { deltaDelayMs: 40 },
    );
    const providerId = await useFakeModel(model.baseUrl);
    try {
      await boot(page);
      await composer(page).fill("survey the acme account and check every bucket policy");
      await composer(page).press("Enter");

      // Live: the first plan.updated places the card; the second rewrites it.
      const card = page.getByTestId("plan-card");
      await expect(card.first()).toBeVisible({ timeout: 60_000 });

      await waitForDurableAnswer(page, /public reads/);
      await expect(page.getByTestId("agent-composer")).not.toHaveAttribute("data-agent-state", "working", { timeout: 60_000 });

      // Durable: ONE card on the persisted turn, folded to "Plan · 2/2".
      const durable = page.locator('[data-testid="work-result"][data-streaming="false"]').last().getByTestId("plan-card");
      await expect(durable).toHaveCount(1, { timeout: 30_000 });
      await expect(durable).toHaveAttribute("data-done", "2");
      await expect(durable).toHaveAttribute("data-total", "2");
      await expect(durable).toHaveAttribute("data-collapsed", "true");
      await expect(durable.getByTestId("plan-head")).toContainText("Plan · 2/2");

      // Opening it shows every step completed, in order.
      await durable.getByTestId("plan-head").click();
      const steps = durable.getByTestId("plan-step");
      await expect(steps).toHaveCount(2);
      await expect(steps.nth(0)).toHaveAttribute("data-status", "completed");
      await expect(steps.nth(0)).toContainText("Survey the account");
      await expect(steps.nth(1)).toHaveAttribute("data-status", "completed");
      await expect(steps.nth(1)).toContainText("Check policies");

      // The plan calls are tool calls the runtime owns — never rows in the
      // worked group, never a step the UI made up.
      await expect(page.getByTestId("worked-row").filter({ hasText: "update_plan" })).toHaveCount(0);

      // The card survives a reload from the persisted `plan` turn item.
      await page.reload();
      await expect(page.getByTestId("plan-card").last()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("plan-card").last()).toHaveAttribute("data-done", "2");
    } finally {
      await dropModelProvider(providerId);
      await model.close();
    }
  });

  test("a turn without update_plan has no plan card", async ({ page }) => {
    const model = await startFakeModel([textTurn("Nothing to plan; the bucket is fine.")]);
    const providerId = await useFakeModel(model.baseUrl);
    try {
      await boot(page);
      await composer(page).fill("is acme-backups fine?");
      await composer(page).press("Enter");
      await waitForDurableAnswer(page, /bucket is fine/);
      await expect(page.getByTestId("plan-card")).toHaveCount(0);
    } finally {
      await dropModelProvider(providerId);
      await model.close();
    }
  });
});
