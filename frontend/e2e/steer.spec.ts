import { expect, test, type Page } from "@playwright/test";
import { sidecarOrigin, watchAgentTaskSurface } from "./agent-tasks-surface";
import { dropModelProvider, startFakeModel, textTurn, useFakeModel } from "./fake-model";

/** Steering is a first-class Agent lifecycle operation. Enter during active
 * Execution directs the CURRENT execution (v0.94): the steer is delivered into
 * the running work — or, when the execution can no longer take it, carried
 * into an automatic follow-up execution — so partial work is preserved, both
 * Directions land in durable task history, and no zombie execution handle is
 * left behind. Nothing is cancelled to make room for the steer. */
const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const task = (page: Page) => page.getByTestId("task-scroll");

const FIRST = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i} about the bucket POLICY on acme-logs.`,
).join(" ");
const SECOND = "Short answer: the LIFECYCLE rule is what expires those objects.";

async function open(page: Page) {
  const model = await startFakeModel([textTurn(FIRST), textTurn(SECOND)], { deltaDelayMs: 150 });
  const providerId = await useFakeModel(model.baseUrl);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
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

async function direct(page: Page, direction: string) {
  await composer(page).fill(direction);
  await composer(page).press("Enter");
}

test.describe("steering active Agent Execution", () => {
  // Steering no longer truncates the current execution (v0.94): the first
  // execution streams to completion (~12s of paced deltas) and the steer then
  // runs as its own execution. The honest end-to-end flow is legitimately
  // about twice as long as the old cancel-and-resend one, so the default 30s
  // budget is too tight when the whole file runs on a cold CI runner.
  test.describe.configure({ timeout: 60_000 });
  test("Enter during Execution applies the new Direction immediately", async ({ page }) => {
    const { cleanup } = await open(page);
    const surface = watchAgentTaskSurface(page);
    try {
      await direct(page, "why does acme-logs return 403?");
      await expect(task(page).getByText(/Paragraph 0 about the bucket POLICY/)).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => surface.saw(/POST \/agent-tasks\/.+\/executions/), {
        timeout: 20_000,
        message: "delegation must hit POST /agent-tasks/{id}/executions",
      }).toBe(true);
      await expect.poll(() => surface.saw(/GET \/agent-tasks\/.+\/events/), {
        timeout: 20_000,
        message: "live work must follow the durable event stream",
      }).toBe(true);
      await direct(page, "actually, what expires those objects?");
      await expect(task(page).getByText(/LIFECYCLE rule is what expires/)).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => surface.saw(/POST \/agent-tasks\/.+\/steer/), {
        timeout: 20_000,
        message: "steering must hit POST /agent-tasks/{id}/steer",
      }).toBe(true);
    } finally { await cleanup(); }
  });

  test("the Steering Direction leaves the Composer after dispatch", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await direct(page, "why does acme-logs return 403?");
      await expect(task(page).getByText(/Paragraph 0 about the bucket POLICY/)).toBeVisible({ timeout: 30_000 });
      await direct(page, "actually, what expires those objects?");
      await expect(task(page).getByText(/LIFECYCLE rule is what expires/)).toBeVisible({ timeout: 60_000 });
      await expect(composer(page)).toHaveValue("");
    } finally { await cleanup(); }
  });

  test("partial work from the redirected Execution remains in task history", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await direct(page, "why does acme-logs return 403?");
      await expect(task(page).getByText(/Paragraph 0 about the bucket POLICY/)).toBeVisible({ timeout: 30_000 });
      await direct(page, "actually, what expires those objects?");
      await expect(task(page).getByText(/LIFECYCLE rule is what expires/)).toBeVisible({ timeout: 60_000 });
      const text = await task(page).evaluate((el) => el.textContent ?? "");
      expect(text).toContain("why does acme-logs return 403?");
      expect(text).toContain("actually, what expires those objects?");
      expect(text).toContain("Paragraph 0 about the bucket POLICY");
    } finally { await cleanup(); }
  });

  test("the steered task survives a reload", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await direct(page, "why does acme-logs return 403?");
      await expect(task(page).getByText(/Paragraph 0 about the bucket POLICY/)).toBeVisible({ timeout: 30_000 });
      await direct(page, "actually, what expires those objects?");
      await expect(task(page).getByText(/LIFECYCLE rule is what expires/)).toBeVisible({ timeout: 60_000 });
      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => await task(page).evaluate((el) => el.textContent ?? ""), {
          timeout: 20_000,
          message: "both Directions must remain in the durable Agent task",
        })
        .toContain("actually, what expires those objects?");
      expect(await task(page).evaluate((el) => el.textContent ?? "")).toContain("why does acme-logs return 403?");
    } finally { await cleanup(); }
  });

  test("the redirected Execution releases its server-side handle", async ({ page }) => {
    const { cleanup } = await open(page);
    try {
      await direct(page, "why does acme-logs return 403?");
      await expect(task(page).getByText(/Paragraph 0 about the bucket POLICY/)).toBeVisible({ timeout: 30_000 });
      await direct(page, "actually, what expires those objects?");
      await expect(task(page).getByText(/LIFECYCLE rule is what expires/)).toBeVisible({ timeout: 60_000 });
      const tasks = (await (await fetch(`${sidecarOrigin()}/agent-tasks`)).json()) as Array<{ id: string }>;
      const states = await Promise.all(
        tasks.map(async (item) => (await (await fetch(`${sidecarOrigin()}/agent-tasks/${item.id}/state`)).json()) as {
          active_execution: { status: string } | null;
        }),
      );
      expect(states.every((state) => {
        const status = state.active_execution?.status;
        return !status || status === "waiting";
      })).toBe(true);
    } finally { await cleanup(); }
  });
});
