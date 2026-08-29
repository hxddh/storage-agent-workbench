import { expect, test, type Page } from "@playwright/test";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel } from "./fake-model";

/**
 * The report is a durable Agent artifact that can leave the local app. Report
 * tests therefore defend both task fidelity and redaction at the export boundary.
 */

const composer = (page: Page) => page.getByTestId("agent-composer").getByRole("textbox");
const task = (page: Page) => page.getByTestId("task-scroll");

const SKILL = "storageops-security-iam-policy";
const SIGNATURE = "4a7c1e9b2f0d8a6c5e3b1d9f7a5c3e1b0d8f6a4c2e0b9d7f5a3c1e9b7d5f3a1c";
const CREDENTIAL = "AKIAIOSFODNN7EXAMPLE%2F20260601%2Fus-east-1%2Fs3%2Faws4_request";
const PRESIGNED =
  "https://acme-logs.s3.us-east-1.amazonaws.com/logs/2026/06/part-0001.parquet" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
  `&X-Amz-Credential=${CREDENTIAL}` +
  "&X-Amz-Date=20260601T101500Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host" +
  `&X-Amz-Signature=${SIGNATURE}`;

const QUESTION = `this presigned link 403s, why? ${PRESIGNED}`;
const ANSWER =
  "The link expired: X-Amz-Expires is 900 seconds from an X-Amz-Date of " +
  "2026-06-01T10:15:00Z, so it stopped being valid at 10:30. Regenerate it.";

function withModel(turns: string[][]) {
  return async function setup(page: Page) {
    const model = await startFakeModel(turns);
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
  };
}

const oneTurn = withModel([toolTurn("read_skill", { name: SKILL }), textTurn(ANSWER)]);

async function ask(page: Page, question: string) {
  await composer(page).click();
  await composer(page).fill(question);
  await composer(page).press("Enter");
}

async function openReport(page: Page) {
  await composer(page).click();
  await composer(page).fill("/report");
  await composer(page).press("Enter");
}

async function reportText(page: Page): Promise<string> {
  const report = page.getByTestId("report-artifact");
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report.getByRole("heading", { level: 1, name: "Report" })).toBeVisible({ timeout: 30_000 });
  return await report.evaluate((el) => el.textContent ?? "");
}

test.describe("durable Agent report artifact", () => {
  test("/report renders the task that just ran", async ({ page }) => {
    const { cleanup } = await oneTurn(page);
    try {
      await ask(page, QUESTION);
      await expect(page.getByTestId("execution-summary-toggle")).toBeVisible({ timeout: 60_000 });
      await openReport(page);
      const md = await reportText(page);
      expect(md).toContain("this presigned link 403s");
      expect(md).toContain("X-Amz-Expires is 900 seconds");
    } finally { await cleanup(); }
  });

  test("the tools the Agent ran are in the report", async ({ page }) => {
    const { cleanup } = await oneTurn(page);
    try {
      await ask(page, QUESTION);
      await expect(page.getByTestId("execution-summary-toggle")).toBeVisible({ timeout: 60_000 });
      await openReport(page);
      expect(await reportText(page)).toContain("read_skill");
    } finally { await cleanup(); }
  });

  test("the pasted signature is not in the artifact", async ({ page }) => {
    const { cleanup } = await oneTurn(page);
    try {
      await ask(page, QUESTION);
      await expect(page.getByTestId("execution-summary-toggle")).toBeVisible({ timeout: 60_000 });
      await openReport(page);
      const md = await reportText(page);
      expect(md).toContain("part-0001.parquet");
      expect(md).not.toContain(SIGNATURE);
      expect(md).not.toContain("AKIAIOSFODNN7EXAMPLE");
    } finally { await cleanup(); }
  });

  test("the pasted signature never reached the model either", async ({ page }) => {
    const { model, cleanup } = await oneTurn(page);
    try {
      await ask(page, QUESTION);
      await expect(page.getByTestId("execution-summary-toggle")).toBeVisible({ timeout: 60_000 });
      const sent = JSON.stringify(model.requests);
      expect(sent).not.toContain(SIGNATURE);
      expect(sent).not.toContain("AKIAIOSFODNN7EXAMPLE");
    } finally { await cleanup(); }
  });

  test("artifact identifiers remain readable, not mangled", async ({ page }) => {
    const { cleanup } = await oneTurn(page);
    try {
      await ask(page, QUESTION);
      await expect(page.getByTestId("execution-summary-toggle")).toBeVisible({ timeout: 60_000 });
      await openReport(page);
      const md = await reportText(page);
      expect(md).toContain("run_account_discovery");
      expect(md).not.toContain("runaccountdiscovery");
      expect(md).toContain("read_skill");
    } finally { await cleanup(); }
  });

  test("Download writes the report as a markdown file", async ({ page }) => {
    const { cleanup } = await oneTurn(page);
    try {
      await ask(page, QUESTION);
      await expect(page.getByTestId("execution-summary-toggle")).toBeVisible({ timeout: 60_000 });
      await openReport(page);
      await reportText(page);
      const download = page.waitForEvent("download", { timeout: 20_000 });
      await page.getByTestId("report-save").click();
      const file = await download;
      expect(file.suggestedFilename()).toBe("report.md");
    } finally { await cleanup(); }
  });

  test("/report before a task exists explains the prerequisite instead of opening a blank artifact", async ({ page }) => {
    const { cleanup } = await oneTurn(page);
    try {
      await openReport(page);
      await expect(task(page).getByText(/Create an Agent task before generating a Report artifact/i)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("report-artifact")).toHaveCount(0);
    } finally { await cleanup(); }
  });
});
