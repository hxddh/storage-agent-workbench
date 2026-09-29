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

test("what a survey learns outlives the task: the home says what needs attention", async ({ page }) => {
  const storageId = await addStorage(s3.endpointUrl);
  model = await startFakeModel([toolTurn("survey_account", { provider_id: storageId }),
    textTurn("Surveyed both buckets.")]);
  providerId = await useFakeModel(model.baseUrl);
  await boot(page);
  await delegate(page, "Survey my storage account");
  await expect(page.getByTestId("answer")).toContainText("Surveyed both buckets.", { timeout: 30_000 });
  await settled(page);
  await page.getByTestId("activity-line").click();
  await expect(page.locator(".call-row").first()).toHaveAttribute("data-status", "ok");
  await expect(page.locator(".call-row").first()).toContainText("Surveyed account");

  await page.getByTestId("new-task").click();
  await expect(page.getByTestId("estate")).toContainText("acme-prod");
  await expect(page.getByTestId("estate")).toContainText("2 buckets");
  await expect(page.getByTestId("needs-care").getByTestId("issue").first()).toBeVisible();
  expect(s3.requests.filter((r) => /^(PUT|POST|DELETE) /.test(r))).toEqual([]);
});

test("a bucket opens beside the Composer: its issues, a fix that says what it cannot tell, notes, Ask", async ({ page }) => {
  const storageId = await addStorage(s3.endpointUrl);
  model = await startFakeModel([toolTurn("survey_account", { provider_id: storageId }), textTurn("Surveyed.")]);
  providerId = await useFakeModel(model.baseUrl);
  await boot(page);
  await delegate(page, "Survey my storage account");
  await expect(page.getByTestId("answer")).toContainText("Surveyed.", { timeout: 30_000 });
  await settled(page);

  await page.getByTestId("new-task").click();
  await page.getByTestId("needs-care").getByTestId("issue").filter({ hasText: "acme-www" }).first().click();
  const sheet = page.getByTestId("bucket-sheet");
  await expect(sheet).toContainText("acme-www");
  await expect(page.getByTestId("composer")).toBeVisible(); // the Composer stays beside it

  // A note is kept on the bucket and survives a reopen.
  await page.getByTestId("note-input").fill("Serves the marketing site.");
  await page.getByTestId("note-input").press("Enter");
  await expect(sheet.getByTestId("note")).toContainText("Serves the marketing site.");

  // The fix pack: CLI, Terraform, JSON — and an honest impact preview.
  const issue = sheet.getByTestId("issue").first();
  await issue.locator(".issue-head").click();
  const show = issue.getByRole("button", { name: "Show the fix" });
  if (await show.count()) {
    await show.click();
    await issue.getByRole("button", { name: "Terraform" }).click();
    await expect(issue.locator(".issue-fix pre")).toContainText("resource \"aws_s3_bucket");
    await expect(issue.getByTestId("impact")).toHaveAttribute("data-verdict", /low|caution|unknown/);
  }

  // Ask about this bucket fills the Composer in place; it never submits.
  await sheet.getByTestId("ask-bucket").click();
  await expect(page.getByTestId("composer-input")).toHaveValue(/acme-www/);
  await expect(page.getByTestId("home")).toBeVisible();
  expect(s3.requests.filter((r) => /^(PUT|POST|DELETE) /.test(r))).toEqual([]);
});
