import { expect, test } from "@playwright/test";
import { addStorage, boot, delegate, reset, settled } from "./app";
import { dropModelProvider, startFakeModel, textTurn, toolTurn, useFakeModel, type FakeModel } from "./fake-model";
import { startFakeS3, type FakeS3 } from "./fake-s3";

let model: FakeModel;
let s3: FakeS3;
let providerId = "";

test.beforeEach(async () => {
  await reset();
  s3 = await startFakeS3({ "acme-www": ["index.html"], "acme-logs": ["2026/09/01/a.log"] },
    { config: { "acme-www": {}, "acme-logs": { encrypted: true } } });
});
test.afterEach(async () => {
  if (providerId) await dropModelProvider(providerId);
  await model?.close();
  await s3.close();
});

test("what a survey learns outlives the task: the home shows the estate and what needs care", async ({ page }) => {
  const storageId = await addStorage(s3.endpointUrl);
  model = await startFakeModel([toolTurn("survey_account", { provider_id: storageId }),
    textTurn("Surveyed both buckets.")]);
  providerId = await useFakeModel(model.baseUrl);
  await boot(page);
  await delegate(page, "Survey my storage account");
  await expect(page.getByTestId("result")).toContainText("Surveyed both buckets.", { timeout: 30_000 });
  await settled(page);
  await page.getByRole("button", { name: /Worked for/ }).click();
  await expect(page.locator(".tool-row").first()).toHaveAttribute("data-status", "ok");
  await expect(page.locator(".tool-row").first()).toContainText("Surveyed account");

  await page.getByTestId("nav-home").click();
  await expect(page.getByTestId("estate")).toContainText("acme-prod");
  await expect(page.getByTestId("estate")).toContainText("2 buckets");
  const care = page.getByTestId("needs-care");
  await expect(care.getByTestId("issue").first()).toBeVisible();
  const issue = care.getByTestId("issue").filter({ hasText: "acme-www" }).first();
  await issue.locator(".issue-head").click();
  // The fix is text for the user; storage stays read-only.
  const fix = issue.getByRole("button", { name: "Show the fix" });
  if (await fix.count()) {
    await fix.click();
    await expect(issue.locator(".issue-fix pre")).toContainText("aws");
    await expect(issue).toContainText("never writes to storage");
  }
  await issue.getByRole("button", { name: "Open task" }).click();
  await expect(page.getByTestId("result")).toContainText("Surveyed both buckets.");
  expect(s3.requests.filter((r) => /^(PUT|POST|DELETE) /.test(r))).toEqual([]);
});
