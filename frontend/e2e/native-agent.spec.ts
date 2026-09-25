import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";
import { waitForDurableAnswer } from "./work-result";

/**
 * v2.1 — native agent: nothing pauses a Task for approval, and the model
 * keeps no plan.
 *
 * The one data-moving tool (`import_evidence`) runs inside the execution,
 * bounded server-side; its result is an ordinary tool row and the execution
 * never parks. Settings states the read-only floor in General — there is no
 * Safety pane, no approval policy, and no approval route.
 */

const SIDECAR = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;
const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
}

test.describe("native agent", () => {
  test.describe.configure({ timeout: 120_000 });

  test("an import call runs in the turn — no approval card, no waiting state", async ({ page }) => {
    // No survey ran in this task, so the tool answers with its own bounded
    // refusal; what matters is that nothing parked the execution to ask.
    // import_evidence lives in the `evidence_import` group: unlock it first,
    // as the model does.
    const model = await startFakeModel([
      toolTurn("load_tools", { group: "evidence_import" }),
      toolTurn("import_evidence", { source_type: "access_log", bucket_name: "acme-logs",
        time_range_start: "2026-09-01T00:00:00Z", time_range_end: "2026-09-02T00:00:00Z" }),
      textTurn("I need an account survey before importing the access logs."),
    ]);
    const providerId = await useFakeModel(model.baseUrl);
    try {
      await boot(page);
      await composer(page).fill("import the acme-logs access logs and analyze them");
      await composer(page).press("Enter");
      await waitForDurableAnswer(page, /account survey before importing/);
      await expect(page.getByTestId("approval-card")).toHaveCount(0);
      await expect(page.getByText(/Waiting for approval/)).toHaveCount(0);
      const group = page.getByTestId("task-log").getByTestId("worked-group").last();
      if ((await group.getAttribute("data-expanded")) === "false") await group.getByTestId("execution-head").click();
      await expect(group.locator('[data-testid="worked-row"][data-tool="import_evidence"]')).toHaveCount(1);
      await expect(page.getByTestId("plan-card")).toHaveCount(0);
    } finally {
      await dropModelProvider(providerId);
      await model.close();
    }
  });

  test("Settings states the floor in General; there is no Safety pane or approval policy", async ({ page, request }) => {
    await boot(page);
    await page.getByTestId("task-navigation-settings").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    const note = page.getByTestId("settings-safety");
    await expect(note).toBeVisible();
    await expect(note).toContainText("read-only");
    await expect(note).toContainText("500 files / 256 MiB");
    await expect(page.getByRole("button", { name: /^Safety$/ })).toHaveCount(0);
    await expect(page.getByTestId("approval-policy")).toHaveCount(0);
    expect((await request.get(`${SIDECAR}/settings/approval-policy`)).status()).toBe(404);
  });
});
