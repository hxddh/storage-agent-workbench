import { expect, test, type Page } from "@playwright/test";
import { sidecarOrigin } from "./agent-tasks-surface";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";
import { seedOptimizationTask } from "./seed";

/**
 * v0.96 closed loop against the real Sidecar: cost simulator → remediation
 * plan Artifact → Verify Execution → Drift report, plus a due revisit that
 * catch-up-submits through the existing runtime path and stops at a pending
 * Decision.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const task = (page: Page) => page.getByTestId("task-scroll");

const PLAN_ANSWER =
  "## Cost review\n\n" +
  "This is an estimate from the local simulator, coverage 100 objects / 100 GB as of 2026-08-01.\n\n" +
  "A remediation plan Artifact was drafted with a pasteable AbortIncompleteMultipartUpload rule. Apply it in your own console; Storage Agent stays read-only.\n\n" +
  "```json\n" +
  JSON.stringify({
    skills_used: [],
    evidence_used: ["simulate_storage_cost", "draft_remediation_plan", "capture_task_baseline"],
    evidence_gaps: [],
    next_action_proposals: [],
  }) +
  "\n```";

const VERIFY_ANSWER =
  "## Verify\n\n" +
  "Read-only re-probe complete. Abort-MPU is not_applied; the plan stays proposed.\n\n" +
  "```json\n" +
  JSON.stringify({
    skills_used: [],
    evidence_used: ["verify_remediation_plan"],
    evidence_gaps: ["live lifecycle did not yet show the recommended abort-MPU rule"],
    next_action_proposals: [],
  }) +
  "\n```";

const DRIFT_ANSWER =
  "## Drift report\n\n" +
  "Compared against baseline v1. Findings still present: incomplete multipart uploads are not aborted. No fabricated trend — two bounded snapshots only.\n\n" +
  "```json\n" +
  JSON.stringify({
    skills_used: [],
    evidence_used: ["compare_task_drift"],
    evidence_gaps: [],
    next_action_proposals: [],
  }) +
  "\n```";

const REVISIT_ANSWER =
  "## Catch-up revisit\n\n" +
  "Read-only re-check after the app was closed past the due time. A confirmation-gated import is proposed and must wait.\n\n" +
  "```json\n" +
  JSON.stringify({
    skills_used: [],
    evidence_used: ["compare_task_drift"],
    evidence_gaps: [],
    next_action_proposals: [
      {
        title: "Import discovered access logs",
        reason: "This downloads bounded evidence from the discovered logging target.",
        action_type: "plan_access_log_import",
        requires_confirmation: true,
        confidence: "high",
        source_run_ids: [],
        prefill: { bucket_name: "acme-logs", prefix: "logs/2026/", source_type: "access_log" },
      },
    ],
  }) +
  "\n```";

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
}

async function confirmPrices() {
  const res = await fetch(`${sidecarOrigin()}/settings/price-table`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmed: true }),
  });
  expect(res.ok).toBe(true);
}

test.describe("v0.96 optimization copilot closed loop", () => {
  test.describe.configure({ timeout: 240_000 });

  test("cost review produces a plan, Verify execution, and Drift report", async ({ page }) => {
    await confirmPrices();
    const { title, id } = seedOptimizationTask("Cost review closed loop", "inventory");
    const model = await startFakeModel([
      toolTurn("simulate_storage_cost", {}),
      toolTurn("draft_remediation_plan", {}),
      toolTurn("capture_task_baseline", {}),
      textTurn(PLAN_ANSWER),
      toolTurn("verify_remediation_plan", {}),
      textTurn(VERIFY_ANSWER),
      toolTurn("compare_task_drift", {}),
      textTurn(DRIFT_ANSWER),
    ]);
    const providerId = await useFakeModel(model.baseUrl);
    try {
      await boot(page);
      await page.getByText(title, { exact: true }).first().click();
      await expect(page.getByTestId("work-result").first()).toBeVisible({ timeout: 20_000 });
      await composer(page).fill(
        "Run a cost and lifecycle review with the local simulator, draft a remediation plan, and capture a baseline.",
      );
      await composer(page).press("Enter");
      await expect(task(page).getByText(/estimate from the local simulator/i)).toBeVisible({ timeout: 90_000 });
      const plans = await (await fetch(`${sidecarOrigin()}/agent-tasks/${id}/remediation-plans`)).json() as {
        plans: Array<{ status: string }>;
      };
      expect(plans.plans.length).toBeGreaterThan(0);
      const artifacts = await (await fetch(`${sidecarOrigin()}/agent-tasks/${id}/artifacts`)).json() as {
        artifacts: Array<{ artifact_type: string }>;
      };
      expect(artifacts.artifacts.some((a) => a.artifact_type === "remediation_plan")).toBe(true);
      await composer(page).fill("Verify the remediation plan with read-only probes.");
      await composer(page).press("Enter");
      await expect(task(page).getByText(/Read-only re-probe complete/i)).toBeVisible({ timeout: 90_000 });
      await composer(page).fill("Produce a Drift report against the stored baseline.");
      await composer(page).press("Enter");
      await expect(task(page).getByText(/Compared against baseline/i)).toBeVisible({ timeout: 90_000 });
      const after = await (await fetch(`${sidecarOrigin()}/agent-tasks/${id}/artifacts`)).json() as {
        artifacts: Array<{ artifact_type: string }>;
      };
      expect(after.artifacts.some((a) => a.artifact_type === "drift_report")).toBe(true);
      await expect(page.getByTestId("task-verify")).toHaveCount(0);
      await expect(page.getByTestId("agent-task-review")).toHaveCount(0);
      await expect(page.getByTestId("remediation-plan-status")).toHaveCount(0);
    } finally {
      await dropModelProvider(providerId);
      await model.close();
    }
  });

  test("due revisit catch-up is a read-only Execution that stops at a pending Decision", async ({ page }) => {
    const { title, id } = seedOptimizationTask("Due revisit catch-up", "due");
    const model = await startFakeModel([
      toolTurn("compare_task_drift", {}),
      textTurn(REVISIT_ANSWER),
    ]);
    const providerId = await useFakeModel(model.baseUrl);
    try {
      await boot(page);
      await page.getByText(title, { exact: true }).first().click();
      await expect.poll(async () => {
        const state = await (await fetch(`${sidecarOrigin()}/agent-tasks/${id}/state`)).json() as {
          pending_decisions: Array<{ status: string; action_type: string }>;
          last_execution: { kind?: string; direction?: string; status: string } | null;
        };
        const revisit = state.last_execution?.kind === "revisit"
          || /\[revisit\]/.test(state.last_execution?.direction || "");
        const pending = state.pending_decisions.some(
          (d) => d.status === "pending" && d.action_type === "plan_access_log_import",
        );
        return revisit && pending;
      }, { timeout: 90_000, message: "catch-up revisit must finish as a pending Decision" }).toBe(true);
      await expect(page.getByTestId("agent-decision-required")).toBeVisible({ timeout: 20_000 });
      await expect(task(page).getByRole("heading", { name: /Catch-up revisit/i })).toBeVisible();
      const resolved = await (await fetch(`${sidecarOrigin()}/agent-tasks/${id}/decisions`)).json() as {
        decisions: Array<{ status: string }>;
      };
      expect(resolved.decisions.some((d) => d.status === "approved")).toBe(false);
    } finally {
      await dropModelProvider(providerId);
      await model.close();
    }
  });

  test("Composer has no slash SKU catalog", async ({ page }) => {
    await boot(page);
    const box = page.getByTestId("agent-composer").getByRole("textbox");
    await box.fill("/");
    await expect(page.getByRole("button", { name: /\/checkup/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /\/cost/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /\/drift/ })).toHaveCount(0);
  });
});
