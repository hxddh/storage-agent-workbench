import { expect, test, type Page } from "@playwright/test";
import { sidecarOrigin, watchAgentTaskSurface } from "./agent-tasks-surface";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";
import { seedInterruptedTask } from "./seed";

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const task = (page: Page) => page.getByTestId("task-scroll");

const LONG = Array.from(
  { length: 28 },
  (_, i) => `Execution segment ${i}: inspecting acme-logs policy and lifecycle state.`,
).join(" ");

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
}

test.describe("durable Agent Task runtime surface", () => {
  test.describe.configure({ timeout: 90_000 });

  test("Resume recovers an interrupted execution over the event stream", async ({ page }) => {
    const { title, id } = seedInterruptedTask();
    const model = await startFakeModel([textTurn(LONG)], { deltaDelayMs: 40 });
    const providerId = await useFakeModel(model.baseUrl);
    const surface = watchAgentTaskSurface(page);
    try {
      await boot(page);
      await page.getByText(title, { exact: true }).first().click();
      await expect(page.getByTestId("task-resume")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("task-resume-action")).toBeVisible();
      await page.getByTestId("task-resume-action").click();
      await expect.poll(() => surface.saw(/POST \/agent-tasks\/.+\/executions\/.+\/resume/), {
        timeout: 20_000,
        message: "Resume must call POST /agent-tasks/{id}/executions/{eid}/resume",
      }).toBe(true);
      await expect.poll(() => surface.saw(/GET \/agent-tasks\/.+\/executions\/.+\/events/), {
        timeout: 20_000,
        message: "Resume must follow the new execution event stream",
      }).toBe(true);
      await expect(task(page).getByText(/Execution segment 0/)).toBeVisible({ timeout: 60_000 });
      const state = await (await fetch(`${sidecarOrigin()}/agent-tasks/${id}/state`)).json() as {
        last_execution: { status: string } | null;
      };
      expect(["completed", "waiting", "running", "queued"]).toContain(state.last_execution?.status);
    } finally {
      await dropModelProvider(providerId);
      await model.close();
    }
  });

  test("a queued Direction is visible and cancellable while another Execution runs", async ({ page }) => {
    const model = await startFakeModel([textTurn(LONG)], { deltaDelayMs: 180 });
    const providerId = await useFakeModel(model.baseUrl);
    const surface = watchAgentTaskSurface(page);
    try {
      await boot(page);
      await composer(page).fill("Inspect acme-logs deeply.");
      await composer(page).press("Enter");
      await expect(page.getByTestId("agent-composer")).toHaveAttribute("data-agent-state", "working", { timeout: 20_000 });
      await expect.poll(() => surface.taskId(), { timeout: 20_000 }).toBeTruthy();
      const taskId = surface.taskId()!;
      // Live status is painted as soon as Composer submits. Wait until that
      // first Direction is the active execution so the queued card is the
      // second POST, not the still-queued first turn.
      await expect(page.getByTestId("queued-direction")).toHaveCount(0, { timeout: 20_000 });
      const queued = await fetch(`${sidecarOrigin()}/agent-tasks/${taskId}/executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ direction: "then check lifecycle rules on acme-logs" }),
      });
      expect(queued.ok || queued.status === 201).toBe(true);
      await expect(page.getByTestId("queued-direction")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("queued-direction")).toContainText("then check lifecycle rules");
      await page.getByTestId("queued-direction-cancel").click();
      await expect(page.getByTestId("queued-direction")).toHaveCount(0, { timeout: 20_000 });
      await expect.poll(() => surface.saw(/POST \/agent-tasks\/.+\/executions\/.+\/stop/), {
        timeout: 15_000,
      }).toBe(true);
    } finally {
      await dropModelProvider(providerId);
      await model.close();
    }
  });
});
