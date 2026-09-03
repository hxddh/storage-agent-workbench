import { expect, test, type Page } from "@playwright/test";
import { watchAgentTaskSurface } from "./agent-tasks-surface";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";
import { seedExecutionLog, seedSession } from "./seed";
import { waitForDurableAnswer } from "./work-result";

/**
 * v1.12 — Execution detail on the durable log.
 *
 * The Artifacts panel lists the task's durable Executions
 * (`GET /agent-tasks/{id}/executions`) and opens one as a document built
 * from its row plus the task's structured event log
 * (`GET /agent-tasks/{id}/events`): the plan, the tool rows with their
 * wall-clock, the Work Result. One call's sanitized input and output open in
 * place through `GET /sessions/{id}/activity/{call_id}`. Nothing under
 * `/runs` is ever requested.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");

function watchRuns(page: Page): string[] {
  const hits: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/runs/")) hits.push(`${req.method()} ${req.url()}`);
  });
  return hits;
}

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
}

async function openExecutionDetail(page: Page) {
  await page.keyboard.press("Control+i");
  await expect(page.getByTestId("agent-artifacts-panel")).toBeVisible();
  await expect(page.getByTestId("artifacts-section-execution")).toBeVisible();
  const row = page.getByTestId("execution-row").first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByTestId("execution-detail")).toBeVisible();
  await expect(page.getByTestId("execution-status")).toBeVisible();
}

test.describe("Execution detail from the durable log", () => {
  test.describe.configure({ timeout: 120_000 });

  test("a seeded execution opens with its plan, timed rows and Work Result, and requests nothing under /runs", async ({ page }) => {
    const { id, title } = seedSession(1, `execution log ${Date.now()}`, "short");
    const executionId = seedExecutionLog(id);
    const runs = watchRuns(page);
    const surface = watchAgentTaskSurface(page);
    await boot(page);
    await page.getByText(title, { exact: true }).first().click();
    await expect(page.getByTestId("work-result").first()).toBeVisible({ timeout: 20_000 });

    await openExecutionDetail(page);
    const body = page.getByTestId("execution-detail-body");
    await expect(body).toHaveAttribute("data-execution-id", executionId);
    await expect(page.getByTestId("execution-status")).toContainText("complete");
    await expect(body.getByRole("heading", { level: 1 })).toContainText("Review acme-logs");

    // Rows from the durable log: the plan, the commentary, one worked group
    // timed by wall-clock (2s → 14s = 12s), never a sum (3s + 6s + 5s).
    await expect(body.getByTestId("plan-card")).toBeVisible();
    await expect(body.getByTestId("plan-card")).toHaveAttribute("data-done", "2");
    await expect(body.getByTestId("turn-commentary")).toContainText("Reading the bucket configuration first.");
    const group = body.getByTestId("worked-group");
    await expect(group).toBeVisible();
    await expect(group).toContainText(/Worked for 12s · 3 tool calls/);
    if ((await group.getAttribute("data-expanded")) === "false") await group.getByTestId("execution-head").click();
    await expect(group.getByTestId("worked-row")).toHaveCount(3);
    await expect(group.getByTestId("worked-row").first()).toContainText("get_bucket_config_detail");
    await expect(group.getByTestId("worked-row").last()).toContainText("get_bucket_public_access");

    // One call's sanitized input and output, in place.
    await group.getByTestId("trace-row-open").last().click();
    await expect(body.getByTestId("call-detail")).toBeVisible({ timeout: 15_000 });
    await expect(body.getByTestId("call-detail")).toContainText(/"bucket"\s*:\s*"acme-logs"/);

    // The Work Result is the persisted message the log points at.
    await expect(body.getByTestId("execution-result")).toContainText("ANSWER-00");

    expect(surface.saw(new RegExp(`GET /agent-tasks/${id}/executions/${executionId}$`))).toBe(true);
    expect(surface.saw(new RegExp(`GET /agent-tasks/${id}/events\\?after=0`))).toBe(true);
    expect(runs).toEqual([]);
  });

  test("a real execution's detail matches the transcript's rows", async ({ page }) => {
    // read_skill records a tool row without a cloud provider (the fake has
    // none); a bucket probe would be an unknown tool call and run nothing.
    const model = await startFakeModel([
      toolTurn("read_skill", { name: "storageops-security-iam-policy" }),
      textTurn("acme-logs answers HEAD; the policy is the problem."),
    ]);
    const providerId = await useFakeModel(model.baseUrl);
    const runs = watchRuns(page);
    try {
      await boot(page);
      await composer(page).fill("does acme-logs exist?");
      await composer(page).press("Enter");
      await waitForDurableAnswer(page, /policy is the problem/);
      await expect(page.getByTestId("agent-composer")).not.toHaveAttribute("data-agent-state", "working", { timeout: 60_000 });

      await openExecutionDetail(page);
      const body = page.getByTestId("execution-detail-body");
      await expect(page.getByTestId("execution-status")).toContainText("complete", { timeout: 20_000 });
      const group = body.getByTestId("worked-group");
      await expect(group).toBeVisible({ timeout: 20_000 });
      if ((await group.getAttribute("data-expanded")) === "false") await group.getByTestId("execution-head").click();
      await expect(group.getByTestId("worked-row").first()).toContainText("read_skill");
      await expect(body.getByTestId("execution-result")).toContainText("policy is the problem");
      await expect(page.getByTestId("execution-error")).toHaveCount(0);
      expect(runs).toEqual([]);
    } finally {
      await dropModelProvider(providerId);
      await model.close();
    }
  });
});
