import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

/**
 * v2.0 — result-first, end to end through the real Sidecar runtime.
 *
 * The model records its conclusion with the `record_conclusion` tool; the
 * runtime persists it (session_messages.conclusion + work_results, migration
 * 031) and announces it (`conclusion.recorded`). The Task then leads with it:
 * answer, findings by severity, next steps that go into the Composer — and the
 * full answer below. A turn that records nothing shows the answer alone.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");

const CONCLUSION = {
  answer: "acme-logs denies list because its bucket policy omits s3:ListBucket.",
  findings: [
    { title: "No lifecycle rule aborts incomplete multipart uploads", severity: "medium", detail: "" },
    { title: "Bucket policy omits s3:ListBucket for the caller", severity: "high",
      detail: "Every ListObjectsV2 returns 403 while HeadObject on a known key succeeds." },
  ],
  next_steps: ["Draft a remediation plan for the bucket policy"],
};
const ANSWER = "## Why list is denied\n\nThe policy grants s3:GetObject but not s3:ListBucket.";

async function boot(page: Page, turns: Parameters<typeof startFakeModel>[0]) {
  const model = await startFakeModel(turns);
  const providerId = await useFakeModel(model.baseUrl);
  await page.addInitScript(() => {
    localStorage.setItem("saw.lang", "en");
    localStorage.setItem("saw.onboarded", "1");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 20_000 });
  return { model, cleanup: async () => { await dropModelProvider(providerId); await model.close(); } };
}

test("a recorded conclusion leads the Task, survives a reload, and its next step goes into the Composer", async ({ page }) => {
  test.setTimeout(90_000);
  const { cleanup } = await boot(page, [
    toolTurn("read_skill", { name: "storageops-security-iam-policy" }),
    toolTurn("record_conclusion", CONCLUSION),
    textTurn(ANSWER),
  ]);
  try {
    await composer(page).fill("Why does acme-logs deny list operations?");
    await composer(page).press("Enter");

    const result = page.getByTestId("task-result");
    await expect(result.getByTestId("result-answer")).toHaveText(CONCLUSION.answer, { timeout: 60_000 });
    // Most severe first, whatever order the model sent.
    const findings = result.getByTestId("result-finding");
    await expect(findings).toHaveCount(2);
    await expect(findings.first()).toHaveAttribute("data-severity", "high");
    await expect(result.getByTestId("turn-answer")).toContainText("grants s3:GetObject but not s3:ListBucket");
    // The conclusion is runtime structure, never a tool row.
    const log = page.getByTestId("task-log");
    const group = log.getByTestId("worked-group").last();
    if ((await group.getAttribute("data-expanded")) === "false") await group.getByTestId("execution-head").click();
    await expect(group.getByTestId("worked-row")).toHaveCount(1);
    await expect(group.getByTestId("worked-row").first()).toHaveAttribute("data-tool", "read_skill");
    await expect(group).not.toContainText("record_conclusion");

    await page.reload();
    await expect(page.getByTestId("task-result").getByTestId("result-answer")).toHaveText(CONCLUSION.answer, { timeout: 20_000 });
    expect(await page.getByTestId("task-scroll").evaluate((el) => el.scrollTop)).toBe(0);

    await page.getByTestId("result-next-step").click();
    await expect(composer(page)).toHaveValue(CONCLUSION.next_steps[0]);
  } finally {
    await cleanup();
  }
});

test("a turn that records no conclusion shows its answer alone — no guessed head", async ({ page }) => {
  test.setTimeout(90_000);
  const { cleanup } = await boot(page, [textTurn("Hello. Which bucket should I look at?")]);
  try {
    await composer(page).fill("hi");
    await composer(page).press("Enter");
    const result = page.getByTestId("task-result");
    await expect(result.getByTestId("turn-answer")).toContainText("Which bucket should I look at?", { timeout: 60_000 });
    await expect(result).toHaveAttribute("data-has-conclusion", "false");
    await expect(page.getByTestId("result-conclusion")).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
